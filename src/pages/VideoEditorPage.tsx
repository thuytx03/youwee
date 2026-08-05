import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DraftGallery } from '@/components/editor/DraftGallery';
import { VideoEditorStudio } from '@/components/editor/VideoEditorStudio';
import { ThemePicker } from '@/components/settings/ThemePicker';
import { useToast } from '@/components/ui/toast';
import { getDraft, type EditorDraft } from '@/lib/editor-drafts';

/**
 * Session state. `key` is captured once when a session opens and remounts the
 * studio: EditorProvider builds its engine in a `useMemo` with empty deps, so a
 * draft's fps and stage size can only be applied on a fresh mount. It must NOT
 * include anything that changes while editing (an `updated_at`, say) or every
 * autosave would tear the engine down mid-edit.
 */
type Session =
  | { mode: 'gallery' }
  | { mode: 'editing'; draft: EditorDraft | null; key: string };

// Elah-based timeline video editor. Elah manages its own project/timeline
// state internally, so this page is a thin shell (no ProcessingContext).
export function VideoEditorPage() {
  const { t } = useTranslation('pages');
  const toast = useToast();
  const [session, setSession] = useState<Session>({ mode: 'gallery' });

  const openDraft = useCallback(
    async (id: string) => {
      try {
        const draft = await getDraft(id);
        if (!draft) {
          toast.error({ title: t('editor.drafts.notFound') });
          return;
        }
        setSession({ mode: 'editing', draft, key: `draft:${draft.id}` });
      } catch (e) {
        toast.error({ title: t('editor.drafts.openFailed'), message: String(e) });
      }
    },
    [toast, t],
  );

  const newProject = useCallback(() => {
    setSession({ mode: 'editing', draft: null, key: `new:${Date.now()}` });
  }, []);

  const exitToGallery = useCallback(() => setSession({ mode: 'gallery' }), []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex-shrink-0 flex items-center justify-between h-12 sm:h-14 px-4 sm:px-6">
        <h1 className="text-base sm:text-lg font-semibold">{t('editor.title')}</h1>
        <ThemePicker />
      </header>
      <div className="mx-4 sm:mx-6 h-px bg-gradient-to-r from-transparent via-border/50 to-transparent" />
      <div className="flex-1 min-h-0 overflow-hidden">
        {session.mode === 'gallery' ? (
          <DraftGallery
            onOpenDraft={(id) => void openDraft(id)}
            onNewProject={newProject}
          />
        ) : (
          <VideoEditorStudio
            key={session.key}
            draft={session.draft}
            onExit={exitToGallery}
          />
        )}
      </div>
    </div>
  );
}
