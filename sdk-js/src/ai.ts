import type {
  AIBridge,
  AIConfigSnapshot,
  AIExtractJsonOptions,
  AISummarizeOptions,
  AITextOptions,
} from './types';

interface InternalAIConfig extends AIConfigSnapshot {
  proxyUrl: string | null;
  ollamaUrl: string | null;
  lmstudioUrl: string | null;
  whisperEndpointUrl: string | null;
  whisperModel: string | null;
}

interface LoggerLike {
  info?(message: string, metadata?: unknown): void;
}

function parseBool(value: string | undefined): boolean {
  return value === 'true';
}

function trimTrailingSlash(value: string | null): string | null {
  return value ? value.replace(/\/+$/, '') : value;
}

export function readAIConfigFromEnv(): InternalAIConfig {
  const env = process.env;

  return {
    enabled: parseBool(env.YOUWEE_AI_ENABLED),
    provider: env.YOUWEE_AI_PROVIDER || null,
    model: env.YOUWEE_AI_MODEL || null,
    proxyUrl: trimTrailingSlash(env.YOUWEE_AI_PROXY_URL || null),
    ollamaUrl: trimTrailingSlash(env.YOUWEE_AI_OLLAMA_URL || null),
    lmstudioUrl: trimTrailingSlash(env.YOUWEE_AI_LMSTUDIO_URL || null),
    timeoutSeconds: Number(env.YOUWEE_AI_TIMEOUT_SECONDS || '120'),
    summaryStyle: env.YOUWEE_AI_SUMMARY_STYLE || 'concise',
    summaryLanguage: env.YOUWEE_AI_SUMMARY_LANGUAGE || 'auto',
    whisperEnabled: parseBool(env.YOUWEE_AI_WHISPER_ENABLED),
    whisperEndpointUrl: trimTrailingSlash(env.YOUWEE_AI_WHISPER_ENDPOINT_URL || null),
    whisperModel: env.YOUWEE_AI_WHISPER_MODEL || null,
    hasApiKey: false,
    hasWhisperApiKey: false,
  };
}

export function createAIBridge(logger?: LoggerLike): AIBridge {
  return {
    available() {
      return false;
    },

    getConfig() {
      return {
        enabled: false,
        provider: null,
        model: null,
        timeoutSeconds: 120,
        summaryStyle: 'concise',
        summaryLanguage: 'auto',
        whisperEnabled: false,
        hasApiKey: false,
        hasWhisperApiKey: false,
      };
    },

    async generateText(_options) {
      logger?.info?.('Blocked plugin AI helper without delegated app bridge');
      throw new Error(
        'Plugin AI helpers are disabled until Youwee provides a delegated AI bridge without exposing API keys.',
      );
    },

    async summarize(options) {
      const normalized = normalizeSummarizeOptions(options);
      const prompt = buildSummaryPrompt(normalized);

      return await this.generateText({
        prompt,
        systemPrompt:
          'You are a concise technical summarizer. Return plain text only, with no markdown fence.',
        temperature: 0.2,
      });
    },

    async extractJson<T = unknown>(options: string | AIExtractJsonOptions) {
      const normalized = normalizeExtractJsonOptions(options);
      const prompt = buildExtractJsonPrompt(normalized);
      const raw = await this.generateText({
        prompt,
        systemPrompt:
          normalized.systemPrompt ||
          'Return valid JSON only. Do not include markdown fences, commentary, or prose.',
        temperature: normalized.temperature ?? 0,
      });

      const parsed = parseJsonFromModelOutput<T>(raw);
      if (normalized.validate && !normalized.validate(parsed)) {
        throw new Error('AI response JSON did not pass validation.');
      }
      return parsed;
    },
  };
}

function normalizeSummarizeOptions(options: string | AISummarizeOptions): AISummarizeOptions {
  if (typeof options === 'string') {
    return {
      text: options,
    };
  }
  return options;
}

function normalizeExtractJsonOptions(options: string | AIExtractJsonOptions): AIExtractJsonOptions {
  if (typeof options === 'string') {
    return {
      prompt: options,
    };
  }
  return options;
}

function buildSummaryPrompt(options: AISummarizeOptions): string {
  const sentenceCount = options.maxSentences || 3;
  const titleLine = options.title ? `Title: ${options.title}\n` : '';
  const extraInstruction = options.instructions
    ? `Additional instructions: ${options.instructions}\n`
    : '';

  return [
    'Summarize the following content.',
    `Target length: at most ${sentenceCount} sentences.`,
    titleLine.trim(),
    extraInstruction.trim(),
    'Content:',
    options.text,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildExtractJsonPrompt(options: AIExtractJsonOptions): string {
  const schemaLine = options.schemaDescription
    ? `Expected JSON shape:\n${options.schemaDescription}\n`
    : '';

  return [
    'Convert the following input into valid JSON.',
    schemaLine.trim(),
    'Input:',
    options.prompt,
  ]
    .filter(Boolean)
    .join('\n');
}

function parseJsonFromModelOutput<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    const firstBracket = candidate.indexOf('[');
    const lastBracket = candidate.lastIndexOf(']');

    const objectSlice =
      firstBrace >= 0 && lastBrace > firstBrace ? candidate.slice(firstBrace, lastBrace + 1) : null;
    const arraySlice =
      firstBracket >= 0 && lastBracket > firstBracket
        ? candidate.slice(firstBracket, lastBracket + 1)
        : null;

    for (const slice of [objectSlice, arraySlice]) {
      if (!slice) continue;
      try {
        return JSON.parse(slice) as T;
      } catch {}
    }

    throw new Error('AI response did not contain valid JSON.');
  }
}

export type { AIBridge, AIConfigSnapshot, AIExtractJsonOptions, AISummarizeOptions, AITextOptions };
export { parseJsonFromModelOutput };
