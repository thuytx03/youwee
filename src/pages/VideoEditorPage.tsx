import { useTranslation } from 'react-i18next';
import { VideoEditorStudio } from '@/components/editor/VideoEditorStudio';
import { ThemePicker } from '@/components/settings/ThemePicker';

// Elah-based timeline video editor. Elah manages its own project/timeline
// state internally, so this page is a thin shell (no ProcessingContext).
export function VideoEditorPage() {
  const { t } = useTranslation('pages');

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex-shrink-0 flex items-center justify-between h-12 sm:h-14 px-4 sm:px-6">
        <h1 className="text-base sm:text-lg font-semibold">{t('editor.title')}</h1>
        <ThemePicker />
      </header>
      <div className="mx-4 sm:mx-6 h-px bg-gradient-to-r from-transparent via-border/50 to-transparent" />
      <div className="flex-1 min-h-0 overflow-hidden">
        <VideoEditorStudio />
      </div>
    </div>
  );
}
