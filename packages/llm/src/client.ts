import type { ZodType } from "zod";

export interface LlmCallRecord {
  purpose: string;
  model: string;
  promptTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  success: boolean;
  error?: string;
}

export interface GenerateJsonRequest<T> {
  /** Short label for logging/LlmCall rows, e.g. "design". */
  purpose: string;
  system: string;
  user: string;
  schema: ZodType<T>;
}

/**
 * Returns the model's raw JSON text, unvalidated. Validation (and retrying
 * with the errors fed back) lives in the callers, so every LLM output passes
 * through the same Zod gate regardless of which client produced it.
 */
export interface LlmClient {
  generateJson<T>(req: GenerateJsonRequest<T>): Promise<string>;
}

export type LlmCallLogger = (record: LlmCallRecord) => void | Promise<void>;
