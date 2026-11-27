import type { LinkSide } from "../core/links/model";
import type { Suggestion } from "../linking/automatic/types";
import { consentCovers } from "./config";
import { batchCandidates, buildRequest, estimateTokens, prepareCandidates, type PreparedCandidate } from "./request";
import { AiProviderError, type AiConfig, type AiConsent, type AiDecision, type AiProvider, type AiRejection, type AiRunReport, type AiRunStatus, type TextLookup } from "./types";
import { validateAiAnswer } from "./validate";

/*
 * One AI review run over a list of engine suggestions. The order of the gates is the safety argument:
 *   1. off by default: `enabled` must be true;
 *   2. the provider is the configured one and offers the configured model;
 *   3. consent: without a consent covering this provider and scope, NOTHING is sent (not even one request);
 *   4. per request, before it is sent: cancel, the request limit, the token budget (with the full output allowance);
 *   5. the request runs under a timeout and the caller's signal — raced, so a provider that ignores its signal still
 *      cannot hold the run;
 *   6. every answer goes through validateAiAnswer; only what passes is in `decisions`.
 * A stop keeps what was already validated and lists the rest in `notReviewed`. Decisions are ADVICE for the reviewer: this
 * module makes no link and changes no confidence (docs/AI_INTEGRATION.md §3).
 */

export interface AiRunInput {
  readonly config: AiConfig;
  readonly provider: AiProvider;
  readonly consent: AiConsent | null;
  readonly suggestions: readonly Suggestion[];
  /** line text, used only when the scope is "refs+text" */
  readonly text?: TextLookup;
  readonly isValidTarget?: (side: LinkSide) => boolean;
  readonly signal?: AbortSignal;
  /** values to remove from every message (the API key the host holds), in addition to the usual key shapes */
  readonly secrets?: readonly string[];
  /** waiting between retries; injectable so that tests do not wait */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly progress?: (done: number, total: number) => void;
}

/** Common key shapes (sk-…, key=… in a URL, a Bearer header), removed even when the host did not list the key. */
const KEY_SHAPES = [/\bsk-[A-Za-z0-9_-]{8,}/g, /\b(?:AIza)[A-Za-z0-9_-]{20,}/g, /([?&](?:key|api_key|token)=)[^&\s"']+/gi, /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi];

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 4) t = t.split(s).join("***");
  for (const re of KEY_SHAPES) t = t.replace(re, (_m, p1?: string) => (typeof p1 === "string" ? `${p1}***` : "***"));
  return t;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
    const onAbort = () => (clearTimeout(t), reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });

const MAX_BACKOFF_MS = 30_000;
const nonNegInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

const STATUS_MESSAGE: Record<AiRunStatus, string> = {
  done: "בדיקת הבינה המלאכותית הסתיימה. ההחלטות שלה הן המלצה בלבד: עברו עליהן לפני אישור.",
  disabled: "בדיקת הבינה המלאכותית כבויה (ברירת המחדל). כדי להפעיל אותה, הגדירו enabled: true, ספק ומודל.",
  "consent-required": "לא נשלח דבר: חסרה הסכמה מפורשת לשלוח את ההצעות לספק הזה ובהיקף הזה. אשרו את השליחה והריצו שוב.",
  "config-invalid": "לא נשלח דבר: הגדרות הבינה המלאכותית אינן תקינות. תקנו אותן והריצו שוב.",
  cancelled: "הבדיקה בוטלה. ההחלטות שכבר התקבלו ונבדקו נשמרו; השאר לא נבדק.",
  "budget-exhausted": "הבדיקה נעצרה כי התקציב (maxTotalTokens) היה נגמר בבקשה הבאה. ההחלטות שכבר התקבלו נשמרו; כדי להמשיך, הגדילו את התקציב או הקטינו את הרשימה.",
  "request-limit": "הבדיקה נעצרה במגבלת מספר הבקשות (maxRequests). ההחלטות שכבר התקבלו נשמרו; השאר לא נבדק.",
  error: "הבדיקה נעצרה בשגיאה של הספק. ההחלטות שכבר התקבלו נשמרו; השאר לא נבדק.",
};

const KIND_MESSAGE: Record<AiProviderError["kind"], string> = {
  auth: "הספק דחה את המפתח. בדקו שהמפתח במשתנה הסביבה תקין ושיש לו הרשאה למודל.",
  "rate-limit": "הספק הגביל את קצב הבקשות. נסו שוב מאוחר יותר, או הקטינו את מספר הבקשות.",
  network: "אין חיבור לספק. בדקו את החיבור לרשת ונסו שוב.",
  server: "הספק החזיר שגיאה פנימית. נסו שוב מאוחר יותר.",
  "bad-request": "הספק דחה את הבקשה. ייתכן שהמודל אינו תומך בפלט מובנה (JSON); בחרו מודל אחר.",
  timeout: "הספק לא ענה בזמן (requestTimeoutMs).",
};

export async function runAiReview(input: AiRunInput): Promise<AiRunReport> {
  const { config, provider } = input;
  const secrets = input.secrets ?? [];
  const decisions: AiDecision[] = [];
  const rejections: AiRejection[] = [];
  const messages: string[] = [];
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const allIds = input.suggestions.map((s) => s.id);
  const decidedIds = new Set<string>();
  const report = (status: AiRunStatus, extra: readonly string[] = []): AiRunReport => ({
    status,
    decisions,
    rejections,
    notReviewed: allIds.filter((id) => !decidedIds.has(id)),
    usage: { ...usage },
    messages: [STATUS_MESSAGE[status], ...extra, ...messages].map((m) => redactSecrets(m, secrets)),
  });

  // 1–3: nothing is prepared, let alone sent, before these pass
  if (!config.enabled) return report("disabled");
  if (provider.id !== config.providerId) return report("config-invalid", [`הספק שהוגדר (${config.providerId || "ריק"}) אינו הספק שהופעל (${provider.id}).`]);
  if (!provider.models.includes(config.model)) return report("config-invalid", [`המודל ${config.model || "(ריק)"} אינו ברשימת המודלים של הספק ${provider.id}.`]);
  if (!consentCovers(input.consent, config)) return report("consent-required");

  const L = config.limits;
  const prepared = prepareCandidates(input.suggestions, config.scope, L.maxSnippetChars, input.text);
  const { batches, tooLarge } = batchCandidates(prepared, L.maxCandidatesPerRequest, L.maxInputCharsPerRequest);
  for (const c of tooLarge) rejections.push({ code: "ai/candidate-too-large", suggestionId: c.suggestion.id, message: "ההצעה גדולה מבקשה אחת (maxInputCharsPerRequest), ולכן לא נשלחה." });
  const outer = input.signal;
  const sleep = input.sleep ?? defaultSleep;

  let done = 0;
  for (const batch of batches) {
    const request = buildRequest(config, batch);
    const inputEstimate = estimateTokens(request.system) + estimateTokens(request.user);
    for (let attempt = 0; ; attempt++) {
      // 4: before every attempt
      if (outer?.aborted) return report("cancelled");
      if (usage.requests >= L.maxRequests) return report("request-limit");
      if (usage.inputTokens + usage.outputTokens + inputEstimate + request.maxOutputTokens > L.maxTotalTokens) return report("budget-exhausted");
      usage.requests++;
      let failure: unknown;
      let text: string | undefined;
      try {
        const res = await callWithTimeout(provider, request, L.requestTimeoutMs, outer);
        text = typeof res.text === "string" ? res.text : "";
        const u = res.usage;
        usage.inputTokens += u && nonNegInt(u.inputTokens) ? u.inputTokens : inputEstimate;
        usage.outputTokens += u && nonNegInt(u.outputTokens) ? u.outputTokens : estimateTokens(text);
      } catch (e) {
        failure = e;
        usage.inputTokens += inputEstimate; // a failed request may still be billed: count it
      }
      if (failure === undefined) {
        accept(validateAiAnswer(text!, batch, input.isValidTarget), batch);
        break;
      }
      if (outer?.aborted) return report("cancelled");
      const err = failure instanceof AiProviderError ? failure : new AiProviderError("network", failure instanceof Error ? failure.message : String(failure));
      if (err.retryable && attempt < L.maxRetries) {
        const wait = Math.min(MAX_BACKOFF_MS, err.retryAfterMs ?? 1000 * 2 ** attempt);
        try {
          await sleep(wait, outer ?? new AbortController().signal);
        } catch {
          return report("cancelled");
        }
        continue;
      }
      return report("error", [KIND_MESSAGE[err.kind], `פרטי השגיאה: ${err.message}`]);
    }
    done += batch.length;
    input.progress?.(done, prepared.length);
  }
  return report("done");

  function accept(check: ReturnType<typeof validateAiAnswer>, batch: readonly PreparedCandidate[]): void {
    for (const d of check.decisions) {
      decidedIds.add(d.suggestionId);
      decisions.push({ ...d, reason: redactSecrets(d.reason, secrets) });
    }
    rejections.push(...check.rejections);
    if (check.invented) messages.push(`המודל החזיר ${check.invented} החלטות על הצעות שלא נשלחו אליו; הן נדחו.`);
    if (check.undecided.length && check.undecided.length === batch.length && check.rejections.length) {
      messages.push("תשובה אחת של המודל נדחתה כולה בבדיקה; ההצעות שבה לא נבדקו.");
    }
  }
}

/** The provider's call under the request timeout and the caller's signal, raced so that a stuck provider cannot hold the run. */
async function callWithTimeout(provider: AiProvider, request: Parameters<AiProvider["complete"]>[0], timeoutMs: number, outer?: AbortSignal) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), ctl.abort(new AiProviderError("timeout", `no answer in ${timeoutMs} ms`))), timeoutMs);
  const onOuter = () => ctl.abort(outer!.reason);
  outer?.addEventListener("abort", onOuter, { once: true });
  const stopped = new Promise<never>((_, reject) => {
    ctl.signal.addEventListener("abort", () => reject(timedOut ? new AiProviderError("timeout", `no answer in ${timeoutMs} ms`) : ctl.signal.reason), { once: true });
  });
  try {
    return await Promise.race([provider.complete(request, ctl.signal), stopped]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}
