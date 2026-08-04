// TTS voice presets per provider for the editor voiceover feature.
// Only the two providers the app configures with a usable TTS API are offered.
import { LANGUAGE_OPTIONS } from '@/lib/types';

export type TtsProvider = 'openai' | 'gemini';

export interface TtsVoice {
  id: string;
  label: string;
}

export const TTS_VOICES: Record<TtsProvider, TtsVoice[]> = {
  openai: [
    { id: 'alloy', label: 'Alloy' },
    { id: 'echo', label: 'Echo' },
    { id: 'fable', label: 'Fable' },
    { id: 'onyx', label: 'Onyx' },
    { id: 'nova', label: 'Nova' },
    { id: 'shimmer', label: 'Shimmer' },
    { id: 'coral', label: 'Coral' },
    { id: 'sage', label: 'Sage' },
    { id: 'ash', label: 'Ash' },
  ],
  gemini: [
    { id: 'Kore', label: 'Kore' },
    { id: 'Puck', label: 'Puck' },
    { id: 'Charon', label: 'Charon' },
    { id: 'Zephyr', label: 'Zephyr' },
    { id: 'Aoede', label: 'Aoede' },
    { id: 'Fenrir', label: 'Fenrir' },
    { id: 'Leda', label: 'Leda' },
    { id: 'Orus', label: 'Orus' },
  ],
};

export const DEFAULT_TTS_MODEL: Record<TtsProvider, string> = {
  openai: 'gpt-4o-mini-tts',
  gemini: 'gemini-2.5-flash-preview-tts',
};

// Map the active app UI locale (e.g. "zh-CN") to a translation language option
// (LANGUAGE_OPTIONS code + readable name). Falls back to English.
export function resolveTargetLanguage(uiLocale: string): { code: string; name: string } {
  const norm = uiLocale.toLowerCase();
  const map: Record<string, string> = {
    'zh-cn': 'zh-Hans',
    'zh-hans': 'zh-Hans',
    'zh-tw': 'zh-Hant',
    'zh-hant': 'zh-Hant',
    'pt-br': 'pt-BR',
  };
  const base = norm.split('-')[0];
  const targetCode =
    map[norm] ??
    LANGUAGE_OPTIONS.find((o) => o.code.toLowerCase() === norm)?.code ??
    LANGUAGE_OPTIONS.find((o) => o.code.toLowerCase() === base)?.code ??
    'en';
  const found = LANGUAGE_OPTIONS.find((o) => o.code === targetCode);
  return { code: targetCode, name: found?.name ?? 'English' };
}
