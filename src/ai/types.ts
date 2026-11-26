import type { LinkSide } from "../core/links/model";
import type { Confidence, EngineId } from "../linking/automatic/types";

/*
 * An OPTIONAL second opinion on the engines' suggestions by a language model (V7 §4.17, issue #47). Infrastructure only:
 * the interface, the limits, the consent gate and the deterministic validator. There is no real provider here.
 *
 * Why this layer is outside the product: the single HTML file makes no network call (AGENTS.md 2.1 — the build scan, the
 * CSP and the offline E2E all hold it), so a model behind an API cannot be reached from it. `src/ai` is pure (no fetch,
 * no DOM, no Preact; tests/unit/architecture.test.ts) and no layer of the app imports it, so it never reaches the HTML.
 * A host that may use the network (a CLI, a plugin host) implements `AiProvider` and calls `runAiReview`.
 *
 * The model never makes a link. It sees the engine's candidates (a suggestion and its alternatives, numbered), and may
 * only say, per candidate id it was given, accept option N / reject / unsure. Every answer goes through `validateAiAnswer`,
 * which keeps only decisions about ids that were sent and options that exist, and maps an option back to the ENGINE's
 * own place — so no book id, book title or line can come from the model (docs/AI_INTEGRATION.md).
 */

/** Token counts as the provider reports them (or as `estimateTokens` estimates them when it does not). */
export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A JSON Schema object, passed to a provider that supports structured output. Plain data. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** One request to a model. `user` is the JSON text of the candidates (buildRequest); nothing else is sent. */
export interface AiRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  /** the shape the answer must have (AI_ANSWER_SCHEMA); a provider without structured output puts it in the prompt */
  readonly responseSchema: JsonSchema;
  readonly maxOutputTokens: number;
}

export interface AiResponse {
  /** the model's answer: JSON text, validated by validateAiAnswer — never trusted as is */
  readonly text: string;
  readonly usage?: AiUsage;
}

/**
 * What a provider failed with. A real provider maps its HTTP status to one of these; the runner retries only the
 * retryable ones, within the request limit.
 */
export type AiProviderErrorKind = "auth" | "rate-limit" | "network" | "server" | "bad-request" | "timeout";

export class AiProviderError extends Error {
  override readonly name = "AiProviderError";
  constructor(
    readonly kind: AiProviderErrorKind,
    message: string,
    /** a server's Retry-After, in ms */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.kind === "rate-limit" || this.kind === "network" || this.kind === "server" || this.kind === "timeout";
  }
}

/**
 * The port a host implements. The API key is the provider's own (read by the host from the environment or a key store);
 * it is never part of `AiConfig`, a request, a report or a project file.
 */
export interface AiProvider {
  /** stable id, e.g. "mock"; consent is given per provider id */
  readonly id: string;
  /** true when the content leaves this computer (any hosted API); shown to the user when consent is asked */
  readonly remote: boolean;
  /** the models this provider may be asked for; a config naming another model is refused before any request */
  readonly models: readonly string[];
  /** must stop (reject) when `signal` aborts */
  complete(request: AiRequest, signal: AbortSignal): Promise<AiResponse>;
}

/**
 * What may be sent. "refs": book titles, 1-based line numbers, heRefs, the engine's reasons and scores — no book text.
 * "refs+text": also a short, tag-free snippet of each line. The default is "refs".
 */
export type AiDataScope = "refs" | "refs+text";

/**
 * The user's explicit consent, for one provider and one scope. Without a consent that covers the configured provider and
 * scope, no request is made at all (runAiReview → "consent-required").
 */
export interface AiConsent {
  readonly providerId: string;
  readonly scope: AiDataScope;
  /** ISO time the user agreed; recorded, not checked */
  readonly grantedAt: string;
}

/**
 * A configured rule ("skill") added to the model's instructions, e.g. "a commentary on the Mishnah links to the mishnah,
 * not to the Gemara". Applies to the candidates of the listed engines (all engines when absent).
 */
export interface AiSkill {
  readonly id: string;
  readonly title: string;
  readonly instructions: string;
  readonly engines?: readonly EngineId[];
}

export interface AiLimits {
  /** requests in one run, retries included */
  readonly maxRequests: number;
  readonly maxCandidatesPerRequest: number;
  /** the user JSON of one request, in characters; a candidate alone above it is not sent */
  readonly maxInputCharsPerRequest: number;
  /** the budget of one run: input + output tokens, counted BEFORE a request with its estimate and its full output allowance */
  readonly maxTotalTokens: number;
  readonly maxOutputTokens: number;
  readonly requestTimeoutMs: number;
  /** retries of a retryable failure, per request */
  readonly maxRetries: number;
  /** a line snippet ("refs+text"), in characters */
  readonly maxSnippetChars: number;
}

export interface AiConfig {
  /** default false: the review never runs unless the user turned it on */
  readonly enabled: boolean;
  readonly providerId: string;
  readonly model: string;
  readonly scope: AiDataScope;
  readonly skills: readonly AiSkill[];
  readonly limits: AiLimits;
}

export const DEFAULT_AI_LIMITS: AiLimits = {
  maxRequests: 20,
  maxCandidatesPerRequest: 25,
  maxInputCharsPerRequest: 24_000,
  maxTotalTokens: 200_000,
  maxOutputTokens: 4_000,
  requestTimeoutMs: 60_000,
  maxRetries: 2,
  maxSnippetChars: 300,
};

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  providerId: "",
  model: "",
  scope: "refs",
  skills: [],
  limits: DEFAULT_AI_LIMITS,
};

/** The text of a line, for "refs+text" (the host reads it; undefined when it has none). May contain HTML. */
export type TextLookup = (side: LinkSide) => string | undefined;

/** One place the model may pick, as it is sent: never a book key, only what a reader would see. */
export interface AiOption {
  readonly option: number;
  readonly book: string;
  /** 1-based, as a reader counts */
  readonly line: number;
  readonly heRef?: string;
  readonly text?: string;
  readonly score: number;
}

export interface AiCandidate {
  /** the suggestion's own deterministic id */
  readonly id: string;
  readonly engine: EngineId;
  readonly type: string;
  readonly confidence: Confidence;
  readonly source: { readonly book: string; readonly line: number; readonly text?: string };
  readonly reasons: readonly string[];
  /** option 0 is the engine's choice, then its alternatives, best first */
  readonly options: readonly AiOption[];
}

export type AiVerdict = "accept" | "reject" | "unsure";

/** A decision that passed the validator. `target` is the engine's own place, never one the model wrote. */
export interface AiDecision {
  readonly suggestionId: string;
  readonly verdict: AiVerdict;
  /** for "accept": the option chosen and the engine's place for it */
  readonly option?: number;
  readonly target?: LinkSide;
  /** true when the model chose one of the alternatives over the engine's choice */
  readonly changedTarget: boolean;
  readonly confidence: number;
  /** the model's words: untrusted text, shown as plain text only */
  readonly reason: string;
}

export type AiRejectionCode =
  | "ai/invalid-json"
  | "ai/invalid-shape"
  | "ai/unknown-candidate"
  | "ai/duplicate-decision"
  | "ai/unexpected-field"
  | "ai/invalid-verdict"
  | "ai/invalid-option"
  | "ai/invalid-confidence"
  | "ai/invalid-reason"
  | "ai/invalid-target"
  | "ai/candidate-too-large";

export interface AiRejection {
  readonly code: AiRejectionCode;
  /** the candidate it is about, when known (an id the model invented is NOT echoed: `invented` holds that) */
  readonly suggestionId?: string;
  readonly message: string;
}

export type AiRunStatus =
  | "done"
  | "disabled"
  | "consent-required"
  | "config-invalid"
  | "cancelled"
  | "budget-exhausted"
  | "request-limit"
  | "error";

export interface AiRunReport {
  readonly status: AiRunStatus;
  readonly decisions: readonly AiDecision[];
  readonly rejections: readonly AiRejection[];
  /** suggestion ids that were not decided (not sent, or sent and not answered) */
  readonly notReviewed: readonly string[];
  readonly usage: { readonly requests: number; readonly inputTokens: number; readonly outputTokens: number };
  /** Hebrew, for the user; secrets removed */
  readonly messages: readonly string[];
}
