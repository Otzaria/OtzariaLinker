import type { AiCandidate, AiProvider, AiRequest, AiResponse } from "./types";

/*
 * A provider that answers from a script, with no network and no key: for tests, and for a host's dry run ("show me what
 * would be sent, and how the validator treats an answer"). It records every request it was given.
 */

export type MockResponder = (request: AiRequest, call: number, candidates: readonly AiCandidate[]) => AiResponse | Promise<AiResponse>;

export interface MockProviderOptions {
  readonly id?: string;
  readonly models?: readonly string[];
  readonly respond?: MockResponder;
  /** ms before answering; an abort during the wait rejects with the signal's reason */
  readonly delayMs?: number;
  /** true: the mock does NOT listen to its signal (a stuck provider, to test that the runner still stops) */
  readonly ignoreSignal?: boolean;
}

/** The default script: accept the engine's own choice for every candidate, with its score as the confidence. */
export const acceptEngineChoice: MockResponder = (_req, _call, candidates) => ({
  text: JSON.stringify({
    decisions: candidates.map((c) => ({ id: c.id, verdict: "accept", option: 0, confidence: c.options[0]?.score ?? 0, reason: "תשובה מדומה" })),
  }),
});

export class MockAiProvider implements AiProvider {
  readonly id: string;
  readonly remote = false;
  readonly models: readonly string[];
  readonly calls: AiRequest[] = [];
  private readonly respond: MockResponder;

  constructor(private readonly options: MockProviderOptions = {}) {
    this.id = options.id ?? "mock";
    this.models = options.models ?? ["mock-1"];
    this.respond = options.respond ?? acceptEngineChoice;
  }

  async complete(request: AiRequest, signal: AbortSignal): Promise<AiResponse> {
    this.calls.push(request);
    const call = this.calls.length;
    const { delayMs, ignoreSignal } = this.options;
    if (delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        if (!ignoreSignal) signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
      });
    }
    if (!ignoreSignal) signal.throwIfAborted();
    const candidates = (JSON.parse(request.user) as { candidates: AiCandidate[] }).candidates;
    return this.respond(request, call, candidates);
  }
}
