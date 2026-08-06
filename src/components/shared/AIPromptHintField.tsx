import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface AIPromptHintFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Feature-specific placeholder example, e.g. "Keep product names in English". */
  placeholder?: string;
  /** Extra classes for the wrapper (lets the editor panel and the subtitle dialogs keep their own spacing). */
  className?: string;
  /** Extra classes for the textarea, for themes that don't share the same tokens. */
  textareaClassName?: string;
  /** Start expanded instead of collapsed behind the toggle. */
  defaultOpen?: boolean;
  rows?: number;
}

/**
 * Collapsible "extra instructions for the AI" input.
 *
 * Every AI-backed subtitle action (proofread, grammar fix, translate) builds a
 * fixed prompt whose structural rules — SEG tags, one output item per input
 * item, same order — are what makes the response parseable. Users still need a
 * way to steer the wording for domain-specific material (glossaries, tone,
 * names to leave untranslated), so this collects free-form guidance that gets
 * appended to the built-in prompt instead of replacing it.
 *
 * Collapsed by default: it is an escape hatch, not part of the normal flow.
 */
export function AIPromptHintField({
  value,
  onChange,
  disabled,
  placeholder,
  className,
  textareaClassName,
  defaultOpen = false,
  rows = 3,
}: AIPromptHintFieldProps) {
  // 'common' namespace: this field is shared by the subtitles dialogs ('subtitles')
  // and the editor's dub panel ('pages'), so its own labels can't live in either.
  const { t } = useTranslation('common');
  const textareaId = useId();
  // Keep the panel open whenever there is already text to show, so a
  // non-empty instruction is never hidden behind a collapsed toggle.
  const [open, setOpen] = useState(defaultOpen || value.trim().length > 0);

  return (
    <div className={cn('space-y-2', className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Sparkles className="w-3.5 h-3.5" />
        {t('aiHint.toggle')}
        {!open && value.trim().length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-600 dark:text-purple-400">
            {t('aiHint.active')}
          </span>
        )}
      </button>

      {open && (
        <>
          <textarea
            id={textareaId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            rows={rows}
            placeholder={placeholder ?? t('aiHint.placeholder')}
            className={cn(
              'w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm',
              'placeholder:text-muted-foreground/70',
              'focus:outline-none focus:ring-1 focus:ring-purple-500/60 focus:border-purple-500/60',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              textareaClassName,
            )}
          />
          <p className="text-[11px] text-muted-foreground">{t('aiHint.help')}</p>
        </>
      )}
    </div>
  );
}
