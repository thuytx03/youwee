import { invoke } from '@tauri-apps/api/core';

// Reusable subtitle translation + proofreading via the app's AI
// (generate_ai_response). Logic mirrors src/components/subtitles/TranslateDialog.tsx
// (SEG-tag chunking, retry/backoff, multi-format parsing, recursive split
// fallback) so the editor's SubtitleDubPanel and the Subtitles page behave
// identically. Kept standalone to avoid touching the existing dialog.

const MAX_CHARS = 10_000;
const MAX_ENTRIES = 80;
const MAX_RETRIES = 3;
const REQUEST_SPACING_MS = 1500;
export const TRANSLATE_CANCELLED = 'TRANSLATE_CANCELLED';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shouldRetry(err: unknown): boolean {
  const m = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    m.includes('rate limit') ||
    m.includes('429') ||
    m.includes('quota') ||
    m.includes('overloaded') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('temporarily unavailable') ||
    m.includes('server busy') ||
    m.includes('503') ||
    m.includes('502')
  );
}

function buildTaggedInput(texts: string[]): string {
  return texts.map((t, i) => `<SEG_${i + 1}>\n${t}\n</SEG_${i + 1}>`).join('\n');
}

function extractTagged(raw: string, n: number): string[] | null {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const m = raw.match(new RegExp(`<SEG_${i}>\\s*([\\s\\S]*?)\\s*<\\/SEG_${i}>`, 'i'));
    if (!m) return null;
    out.push(m[1].replace(/^\n+|\n+$/g, ''));
  }
  return out;
}

function extractJsonArray(raw: string): string[] | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const content = fence ? fence[1].trim() : trimmed;
  const tryParse = (s: string): string[] | null => {
    try {
      const p = JSON.parse(s);
      if (Array.isArray(p) && p.every((x) => typeof x === 'string')) return p;
    } catch {
      /* ignore */
    }
    return null;
  };
  const direct = tryParse(content);
  if (direct) return direct;
  const a = content.indexOf('[');
  const b = content.lastIndexOf(']');
  if (a >= 0 && b > a) return tryParse(content.slice(a, b + 1));
  return null;
}

function extractSegments(raw: string, n: number): string[] | null {
  const tagged = extractTagged(raw, n);
  if (tagged && tagged.length === n) return tagged;
  const json = extractJsonArray(raw);
  if (json && json.length === n) return json;
  return null;
}

function chunk<T extends { text: string }>(entries: T[]): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const e of entries) {
    const c = e.text.length + 12;
    if (cur.length > 0 && (chars + c > MAX_CHARS || cur.length >= MAX_ENTRIES)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(e);
    chars += c;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export interface SubtitleAIOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Shared engine for any "run every subtitle text through an LLM, get back the
 * same number of items in the same order" operation (translate, proofread,
 * ...). `buildPrompt` receives the SEG-tagged input block and must return a
 * full prompt instructing the model to preserve the tags/order/count.
 */
async function runSubtitleAIPass(
  texts: string[],
  buildPrompt: (taggedInput: string) => string,
  opts: SubtitleAIOptions,
): Promise<string[]> {
  const { signal, onProgress } = opts;
  const cancelled = () => signal?.aborted;
  const indexed = texts.map((text, i) => ({ text, i }));
  const result = new Array<string>(texts.length);
  let lastReq = 0;
  let done = 0;

  const callAI = async (prompt: string): Promise<string> => {
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      if (cancelled()) throw new Error(TRANSLATE_CANCELLED);
      const wait = REQUEST_SPACING_MS - (Date.now() - lastReq);
      if (wait > 0) await sleep(wait);
      lastReq = Date.now();
      try {
        return await invoke<string>('generate_ai_response', { prompt });
      } catch (err) {
        if (!shouldRetry(err) || attempt === MAX_RETRIES) throw err;
        await sleep(800 * 2 ** attempt + Math.floor(Math.random() * 300));
        attempt += 1;
      }
    }
    return '';
  };

  const processChunk = async (items: { text: string; i: number }[]): Promise<void> => {
    if (cancelled()) throw new Error(TRANSLATE_CANCELLED);
    const prompt = buildPrompt(buildTaggedInput(items.map((x) => x.text)));
    const resp = await callAI(prompt);
    const output = extractSegments(resp, items.length);
    if (output) {
      items.forEach((it, k) => {
        result[it.i] = output[k];
      });
      done += items.length;
      onProgress?.(done, texts.length);
      return;
    }
    // Bad format → split and retry.
    if (items.length > 1) {
      const mid = Math.floor(items.length / 2);
      await processChunk(items.slice(0, mid));
      await processChunk(items.slice(mid));
      return;
    }
    // Single item still unparseable → keep original text.
    result[items[0].i] = items[0].text;
    done += 1;
    onProgress?.(done, texts.length);
  };

  for (const c of chunk(indexed)) {
    await processChunk(c);
  }
  return result;
}

/**
 * Translate an ordered list of subtitle texts into `targetLangName`.
 * Returns translations in the same order/length. Throws TRANSLATE_CANCELLED if aborted.
 */
export async function translateSubtitleTexts(
  texts: string[],
  targetLangName: string,
  opts: SubtitleAIOptions = {},
): Promise<string[]> {
  return runSubtitleAIPass(
    texts,
    (taggedInput) =>
      [
        `Translate the following subtitle texts to ${targetLangName}.`,
        'Return ONLY translated output with EXACTLY the same SEG tags.',
        'Rules:',
        '- Keep the same number of items and the same order.',
        '- Do not merge, split, or drop items.',
        '- Keep SEG tags unchanged.',
        '- Preserve line breaks naturally inside each subtitle.',
        '- Do not add explanations or markdown.',
        `Input:\n${taggedInput}`,
      ].join('\n'),
    opts,
  );
}

/**
 * Proofread an ordered list of subtitle texts straight out of speech-to-text
 * (Whisper), fixing obvious mishearings/typos/mis-transcribed words —
 * WITHOUT rewording, summarizing, or changing meaning. Returns corrected
 * texts in the same order/length so timestamps stay valid. Throws
 * TRANSLATE_CANCELLED if aborted.
 */
export async function proofreadSubtitleTexts(
  texts: string[],
  opts: SubtitleAIOptions = {},
): Promise<string[]> {
  return runSubtitleAIPass(
    texts,
    (taggedInput) =>
      [
        'The following subtitle lines were auto-transcribed by speech-to-text',
        'and may contain mishearings, typos, or wrong words/names that sound',
        'similar to what was actually said.',
        'Fix ONLY clear transcription errors (wrong word/name/spelling that a',
        'human listener would obviously correct). Use the surrounding lines as',
        'context to guess the intended word when a term repeats.',
        'Do NOT rephrase, summarize, translate, add, or remove content — keep',
        'the language, wording, and meaning otherwise identical.',
        'Return ONLY the corrected output with EXACTLY the same SEG tags.',
        'Rules:',
        '- Keep the same number of items and the same order.',
        '- Do not merge, split, or drop items.',
        '- Keep SEG tags unchanged.',
        '- Preserve line breaks naturally inside each subtitle.',
        '- Do not add explanations or markdown.',
        `Input:\n${taggedInput}`,
      ].join('\n'),
    opts,
  );
}
