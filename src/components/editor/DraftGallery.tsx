import { Film, Loader2, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/toast';
import { toAssetUrl } from '@/lib/asset-access';
import {
  deleteDraft,
  listDrafts,
  renameDraft,
  type EditorDraftSummary,
} from '@/lib/editor-drafts';
import { cn } from '@/lib/utils';

const FPS_FALLBACK = 30;

function formatDuration(frames: number, fps: number): string {
  const totalSec = Math.round(frames / (fps || FPS_FALLBACK));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Relative time, falling back to a date once it stops being useful. */
function formatRelative(iso: string, locale: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.round((Date.now() - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (diffSec < 60) return rtf.format(-diffSec, 'second');
  if (diffSec < 3600) return rtf.format(-Math.round(diffSec / 60), 'minute');
  if (diffSec < 86_400) return rtf.format(-Math.round(diffSec / 3600), 'hour');
  if (diffSec < 604_800) return rtf.format(-Math.round(diffSec / 86_400), 'day');
  return new Date(then).toLocaleDateString(locale);
}

/** Thumbnails live on disk under $APPDATA, so they need an asset URL. */
function DraftThumbnail({ path, name }: { path: string | null; name: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    let alive = true;
    toAssetUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  // The wrapper owns the 16:9 box so the tile never resizes with the source
  // video's aspect ratio — a 9:16 clip would otherwise make a very tall card.
  return (
    <div className="relative w-full overflow-hidden rounded-md bg-muted/30" style={{ aspectRatio: '16 / 9' }}>
      {url ? (
        <img
          src={url}
          alt={name}
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <Film className="w-7 h-7 text-muted-foreground/40" />
        </div>
      )}
    </div>
  );
}

interface Props {
  onOpenDraft: (id: string) => void;
  onNewProject: () => void;
}

export function DraftGallery({ onOpenDraft, onNewProject }: Props) {
  const { t, i18n } = useTranslation('pages');
  const toast = useToast();
  const [drafts, setDrafts] = useState<EditorDraftSummary[] | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const refresh = useCallback(async () => {
    try {
      setDrafts(await listDrafts());
    } catch (e) {
      toast.error({ title: t('editor.drafts.loadFailed'), message: String(e) });
      setDrafts([]);
    }
  }, [toast, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = async (draft: EditorDraftSummary) => {
    setMenuFor(null);
    try {
      await deleteDraft(draft.id);
      setDrafts((prev) => prev?.filter((d) => d.id !== draft.id) ?? null);
    } catch (e) {
      toast.error({ title: t('editor.drafts.deleteFailed'), message: String(e) });
    }
  };

  const commitRename = async (id: string) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name) return;
    try {
      await renameDraft(id, name);
      setDrafts((prev) => prev?.map((d) => (d.id === id ? { ...d, name } : d)) ?? null);
    } catch (e) {
      toast.error({ title: t('editor.drafts.renameFailed'), message: String(e) });
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-6 py-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onNewProject}
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer"
        >
          <Plus className="w-4 h-4" /> {t('editor.drafts.newProject')}
        </button>
        {drafts && drafts.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {t('editor.drafts.countLabel', { count: drafts.length })}
          </span>
        )}
      </div>

      {drafts === null && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-8">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('editor.drafts.loading')}
        </div>
      )}

      {drafts?.length === 0 && (
        <div className="mt-16 text-center">
          <Film className="w-10 h-10 mx-auto text-muted-foreground/30" />
          <div className="mt-3 text-sm font-medium">{t('editor.drafts.emptyTitle')}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t('editor.drafts.emptyHint')}
          </div>
        </div>
      )}

      {drafts && drafts.length > 0 && (
        <>
          <div className="mt-6 mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('editor.drafts.sectionTitle')}
          </div>
          {/* auto-fill with a fixed minimum rather than breakpoint column counts:
              this panel lives inside the app shell, so its width doesn't track
              the viewport and `sm:`/`lg:` would size tiles off the wrong box. */}
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
          >
            {drafts.map((draft) => (
              <div key={draft.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onOpenDraft(draft.id)}
                  className="w-full text-left cursor-pointer rounded-lg border border-border/60 bg-card p-2 transition-colors hover:border-border hover:bg-accent/40"
                >
                  <div className="relative">
                    <DraftThumbnail path={draft.thumbnail_path} name={draft.name} />
                    {/* Duration over the frame, like every video tile in the app. */}
                    <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 py-0.5 text-[10px] font-mono text-white tabular-nums">
                      {formatDuration(draft.duration_frames, draft.fps)}
                    </span>
                  </div>
                  <div className="mt-2 truncate text-xs font-medium" title={draft.name}>
                    {draft.name}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {formatRelative(draft.updated_at, i18n.language)}
                  </div>
                </button>

                {/* Rename in place, over the card's title row, so the grid never
                    reflows and no modal is needed. */}
                {renamingId === draft.id && (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void commitRename(draft.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename(draft.id);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="absolute left-2 right-2 bottom-2 z-10 px-1.5 py-1 text-xs rounded border border-primary bg-background outline-none"
                  />
                )}

                {renamingId !== draft.id && (
                  <button
                    type="button"
                    aria-label={t('editor.drafts.moreActions')}
                    onClick={() => setMenuFor(menuFor === draft.id ? null : draft.id)}
                    className={cn(
                      'absolute top-3.5 right-3.5 w-7 h-7 inline-flex items-center justify-center rounded-md bg-background/85 backdrop-blur transition-opacity cursor-pointer',
                      menuFor === draft.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                    )}
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                )}

                {menuFor === draft.id && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMenuFor(null)} />
                    <div className="absolute top-11 right-3.5 z-50 min-w-[140px] rounded-md border border-border bg-popover py-1 shadow-md">
                      <button
                        type="button"
                        onClick={() => {
                          setRenameValue(draft.name);
                          setRenamingId(draft.id);
                          setMenuFor(null);
                        }}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent cursor-pointer"
                      >
                        <Pencil className="w-3.5 h-3.5" /> {t('editor.drafts.rename')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(draft)}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-destructive hover:bg-accent cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> {t('editor.drafts.delete')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
