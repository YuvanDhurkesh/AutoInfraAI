import type { GenerateJsonRequest, LlmClient } from "./client.js";

/**
 * Replays canned responses in order, keyed by request purpose, and records
 * every request it saw -- lets tests (and CI) exercise the full LLM path,
 * including validation-failure retries, without a GEMINI_API_KEY (Sec. 12).
 */
export class MockLlmClient implements LlmClient {
  readonly requests: Array<GenerateJsonRequest<unknown>> = [];
  private readonly queues: Map<string, string[]>;

  constructor(responses: Record<string, Array<string | object>>) {
    this.queues = new Map(
      Object.entries(responses).map(([purpose, list]) => [
        purpose,
        list.map((r) => (typeof r === "string" ? r : JSON.stringify(r))),
      ]),
    );
  }

  async generateJson<T>(req: GenerateJsonRequest<T>): Promise<string> {
    this.requests.push(req as GenerateJsonRequest<unknown>);
    const next = this.queues.get(req.purpose)?.shift();
    if (next === undefined)
      throw new Error(`MockLlmClient: no canned response left for "${req.purpose}"`);
    return next;
  }
}
