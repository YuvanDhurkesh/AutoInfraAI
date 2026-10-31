import { ApiError, GoogleGenAI } from "@google/genai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { GenerateJsonRequest, LlmCallLogger, LlmClient } from "./client.js";

export interface GeminiClientOptions {
  apiKey: string;
  /** Always from GEMINI_MODEL -- never hardcoded (Sec. 4). */
  model: string;
  logger?: LlmCallLogger;
  maxAttempts?: number;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Gemini stayed overloaded/unavailable through every retry, or a quota ran out. */
export class LlmUnavailableError extends Error {
  constructor(
    readonly status: number | undefined,
    message?: string,
  ) {
    super(
      message ??
        (status === 429
          ? "Gemini's rate limit was reached. Wait a minute, then try this step again."
          : 'Gemini is overloaded right now (Google returned "high demand" for every retry). Nothing was changed -- try this step again in a few minutes.'),
    );
  }
}

/**
 * A per-day quota (the free tier allows ~20 requests/day per model) won't
 * clear by retrying: fail at once and say when it resets.
 */
export function dailyQuotaError(message: string): LlmUnavailableError | null {
  if (!/PerDay/i.test(message)) return null;
  const seconds = Number(message.match(/"retryDelay":"(\d+)s"/)?.[1] ?? NaN);
  const wait = Number.isFinite(seconds)
    ? ` It resets in about ${seconds >= 3600 ? `${Math.round(seconds / 3600)} hour(s)` : `${Math.max(1, Math.round(seconds / 60))} minutes`}.`
    : " It resets at midnight Pacific time.";
  return new LlmUnavailableError(
    429,
    `Your Gemini API key has used its daily request quota (the free tier allows about 20 requests per day per model).${wait} Nothing was changed -- try this step again then, or enable billing on the key's Google AI Studio project to raise the limit.`,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GeminiClient implements LlmClient {
  private readonly ai: GoogleGenAI;

  constructor(private readonly options: GeminiClientOptions) {
    this.ai = new GoogleGenAI({ apiKey: options.apiKey });
  }

  async generateJson<T>(req: GenerateJsonRequest<T>): Promise<string> {
    // Demand spikes ("503 high demand") often last a minute or two: ~3 min total.
    const maxAttempts = this.options.maxAttempts ?? 8;
    const jsonSchema = zodToJsonSchema(req.schema, { $refStrategy: "none" });

    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      try {
        const response = await this.ai.models.generateContent({
          model: this.options.model,
          contents: req.user,
          config: {
            systemInstruction: req.system,
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
          },
        });
        const text = response.text ?? "";
        await this.options.logger?.({
          purpose: req.purpose,
          model: this.options.model,
          promptTokens: response.usageMetadata?.promptTokenCount,
          outputTokens: response.usageMetadata?.candidatesTokenCount,
          latencyMs: Date.now() - started,
          success: true,
        });
        return text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.options.logger?.({
          purpose: req.purpose,
          model: this.options.model,
          latencyMs: Date.now() - started,
          success: false,
          error: message,
        });
        const status = err instanceof ApiError ? err.status : undefined;
        const retryable = status === undefined || RETRYABLE_STATUSES.has(status);
        if (!retryable) throw err;
        const daily = status === 429 ? dailyQuotaError(message) : null;
        if (daily) throw daily;
        if (attempt >= maxAttempts) throw new LlmUnavailableError(status);
        await sleep(Math.min(2000 * 2 ** (attempt - 1), 30_000) + Math.random() * 1000);
      }
    }
  }
}
