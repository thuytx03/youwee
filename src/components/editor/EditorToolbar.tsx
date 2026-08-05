import type { PlaybackEngine, TimelineEngine } from '@elah/editor';
import { Redo2, Undo2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportDialog } from './ExportDialog';

interface EditorToolbarProps {
  engine: TimelineEngine | null;
  playback: PlaybackEngine | null;
  /** Draft name, used as the default export filename. */
  projectName?: string | null;
}

/**
 * Top-right editor actions: history plus Export.
 *
 * Deliberately minimal. Clip operations (split, duplicate, delete) live in the
 * timeline toolbar next to the clips they act on, and adding media is done by
 * tapping an asset in the Media panel — a second set of buttons up here only
 * made it ambiguous which one to reach for.
 */
export function EditorToolbar({ engine, projectName }: EditorToolbarProps) {
  const { t } = useTranslation('pages');
  const [exportOpen, setExportOpen] = useState(false);
  // canUndo/canRedo are engine methods, not reactive state, so mirror them from
  // the history event — otherwise the buttons never enable after the first edit.
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  useEffect(() => {
    if (!engine) return;
    setHistory({ canUndo: engine.canUndo(), canRedo: engine.canRedo() });
    const onChange = (h: { canUndo: boolean; canRedo: boolean }) => setHistory(h);
    engine.on('history:change', onChange);
    return () => engine.off('history:change', onChange);
  }, [engine]);

  const ghost =
    'inline-flex items-center justify-center w-8 h-8 rounded-md text-ed-text-muted hover:text-ed-text hover:bg-ed-elevated transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer';

  return (
    <div className="elah-root flex items-center gap-1 px-3 py-1.5 border-b border-ed-border shrink-0">
      <button
        type="button"
        className={ghost}
        onClick={() => engine?.undo()}
        disabled={!history.canUndo}
        title={t('editor.ui.undo')}
      >
        <Undo2 className="w-4 h-4" />
      </button>
      <button
        type="button"
        className={ghost}
        onClick={() => engine?.redo()}
        disabled={!history.canRedo}
        title={t('editor.ui.redo')}
      >
        <Redo2 className="w-4 h-4" />
      </button>

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => setExportOpen(true)}
        disabled={!engine}
        className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 cursor-pointer"
      >
        <Upload className="w-4 h-4" /> {t('editor.export.button')}
      </button>

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        project={engine?.getProject() ?? null}
        defaultName={projectName || t('editor.drafts.untitled')}
      />
    </div>
  );
}
