import { describe, expect, it } from "vitest";
import {
  AiProviderError,
  DEFAULT_AI_CONFIG,
  MockAiProvider,
  batchCandidates,
  buildRequest,
  checkAiConfig,
  estimateTokens,
  prepareCandidates,
  redactSecrets,
  runAiReview,
  validateAiAnswer,
  type AiConfig,
  type AiConsent,
  type AiProvider,
  type AiRunInput,
  type MockResponder,
} from "../../../src/ai";
import type { BookRef, LinkSide } from "../../../src/core/links/model";
import type { Suggestion } from "../../../src/linking/automatic/types";

/*
 * The AI review layer with the Mock provider only (V7 §4.17): off by default, the consent gate, the request limit, the
 * budget, cancel and timeout, retries, the validator (invented ids, invented places, bad shapes) and key protection.
 * No network, no key, no paid service.
 */

const commentary: BookRef = { key: "db:1", title: "רש\"י על בראשית", origin: "otzaria" };
const base: BookRef = { key: "db:2", title: "בראשית", origin: "otzaria" };

function suggestion(n: number, alternatives = 1): Suggestion {
  const target: LinkSide = { book: base, line: n * 10 };
  return {
    id: `dibur-hamatchil:db:1:${n}->db:2:${n * 10}`,
    engine: "dibur-hamatchil",
    source: { book: commentary, line: n },
    target,
    declaredType: "commentary",
    heRef2: `בראשית א, ${n}`,
    score: 0.9,
    confidence: "high",
    reasons: [{ code: "dh/exact", text: `ההפניה בטקסט: "בראשית ברא ${n}"` }],
    rules: ["dh/exact"],
    alternatives: Array.from({ length: alternatives }, (_, i) => ({ target: { book: base, line: n * 10 + i + 1 }, score: 0.7, reasons: [] })),
    warnings: [],
  };
}

const SUGGESTIONS = [1, 2, 3, 4, 5].map((n) => suggestion(n));
const CONFIG: AiConfig = { ...DEFAULT_AI_CONFIG, enabled: true, providerId: "mock", model: "mock-1" };
const CONSENT: AiConsent = { providerId: "mock", scope: "refs", grantedAt: "2026-11-26T00:00:00Z" };
const noSleep = async () => {};

const run = (over: Partial<AiRunInput> & { provider: AiProvider }) =>
  runAiReview({ config: CONFIG, consent: CONSENT, suggestions: SUGGESTIONS, sleep: noSleep, ...over });

const answer = (decisions: unknown[]) => ({ text: JSON.stringify({ decisions }) });

describe("AI review: gates before anything is sent", () => {
  it("is off by default: the default config sends nothing", async () => {
    const provider = new MockAiProvider();
    const r = await run({ provider, config: { ...CONFIG, enabled: false } });
    expect(r.status).toBe("disabled");
    expect(provider.calls).toHaveLength(0);
    expect(DEFAULT_AI_CONFIG.enabled).toBe(false);
    expect(checkAiConfig({}).config.enabled).toBe(false);
    expect(checkAiConfig({ enabled: "true" }).config.enabled).toBe(false); // only the boolean true turns it on
  });

  it("without consent, or with consent for another provider or a narrower scope, no request is made", async () => {
    for (const consent of [null, { ...CONSENT, providerId: "other" }]) {
      const provider = new MockAiProvider();
      const r = await run({ provider, consent });
      expect(r.status).toBe("consent-required");
      expect(provider.calls).toHaveLength(0);
      expect(r.notReviewed).toHaveLength(SUGGESTIONS.length);
    }
    const provider = new MockAiProvider();
    const r = await run({ provider, config: { ...CONFIG, scope: "refs+text" }, consent: CONSENT, text: () => "בראשית ברא" });
    expect(r.status).toBe("consent-required");
    expect(provider.calls).toHaveLength(0);
  });

  it('with consent for "refs", no book text is sent even when the host offers a text lookup', async () => {
    const provider = new MockAiProvider();
    const r = await run({ provider, text: () => "<b>בראשית ברא אלהים</b>" });
    expect(r.status).toBe("done");
    const sent = provider.calls.map((c) => c.user).join("\n");
    expect(sent).not.toContain("אלהים");
    expect(sent).not.toContain("בראשית ברא"); // not even the quote inside the engine's reason: only its code is sent
    expect(sent).toContain("dh/exact");
  });

  it('with consent for "refs+text", a tag-free snippet of each line is sent, cut to maxSnippetChars', async () => {
    const provider = new MockAiProvider();
    const config: AiConfig = { ...CONFIG, scope: "refs+text", limits: { ...CONFIG.limits, maxSnippetChars: 10 } };
    await run({ provider, config, consent: { ...CONSENT, scope: "refs+text" }, text: () => "<b>בראשית</b> ברא אלהים את השמים" });
    const first = JSON.parse(provider.calls[0]!.user).candidates[0];
    expect(first.source.text).toBe("בראשית ברא…");
    expect(provider.calls[0]!.user).not.toContain("<b>");
  });

  it("an unknown model or a provider other than the configured one is refused before any request", async () => {
    const provider = new MockAiProvider();
    expect((await run({ provider, config: { ...CONFIG, model: "gpt-x" } })).status).toBe("config-invalid");
    expect((await run({ provider, config: { ...CONFIG, providerId: "other" }, consent: { ...CONSENT, providerId: "other" } })).status).toBe("config-invalid");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("AI review: limits, budget, cancel", () => {
  it("stops at the request limit and keeps what was decided", async () => {
    const provider = new MockAiProvider();
    const config: AiConfig = { ...CONFIG, limits: { ...CONFIG.limits, maxCandidatesPerRequest: 2, maxRequests: 2 } };
    const r = await run({ provider, config });
    expect(r.status).toBe("request-limit");
    expect(provider.calls).toHaveLength(2);
    expect(r.decisions).toHaveLength(4);
    expect(r.notReviewed).toEqual([SUGGESTIONS[4]!.id]);
  });

  it("stops BEFORE a request that would pass the token budget (the full output allowance is counted)", async () => {
    const provider = new MockAiProvider({ respond: (req, _n, cands) => ({ ...answer(cands.map((c) => ({ id: c.id, verdict: "unsure", option: null, confidence: 0.5, reason: "" }))), usage: { inputTokens: 100, outputTokens: 50 } }) });
    const config0: AiConfig = { ...CONFIG, limits: { ...CONFIG.limits, maxCandidatesPerRequest: 1, maxOutputTokens: 100 } };
    const one = buildRequest(config0, prepareCandidates([SUGGESTIONS[0]!], "refs", 300));
    const estimate = estimateTokens(one.system) + estimateTokens(one.user) + one.maxOutputTokens;
    // enough for the first request (estimate), then 150 spent: the second request's estimate no longer fits
    const config: AiConfig = { ...config0, limits: { ...config0.limits, maxTotalTokens: estimate + 10 } };
    const r = await run({ provider, config });
    expect(r.status).toBe("budget-exhausted");
    expect(provider.calls).toHaveLength(1);
    expect(r.usage).toEqual({ requests: 1, inputTokens: 100, outputTokens: 50 });
    expect(r.decisions).toHaveLength(1);
  });

  it("a budget too small for even one request sends nothing", async () => {
    const provider = new MockAiProvider();
    const r = await run({ provider, config: { ...CONFIG, limits: { ...CONFIG.limits, maxTotalTokens: 10 } } });
    expect(r.status).toBe("budget-exhausted");
    expect(provider.calls).toHaveLength(0);
  });

  it("cancel before the run sends nothing; cancel during a request stops it and keeps earlier decisions", async () => {
    const pre = new AbortController();
    pre.abort();
    const p0 = new MockAiProvider();
    expect((await run({ provider: p0, signal: pre.signal })).status).toBe("cancelled");
    expect(p0.calls).toHaveLength(0);

    const ctl = new AbortController();
    const mock = new MockAiProvider({ delayMs: 50 });
    // the user cancels while the second request is out
    const provider: AiProvider = { id: mock.id, remote: false, models: mock.models, complete: (req, signal) => (mock.calls.length === 1 && setTimeout(() => ctl.abort(), 5), mock.complete(req, signal)) };
    const config: AiConfig = { ...CONFIG, limits: { ...CONFIG.limits, maxCandidatesPerRequest: 2 } };
    const r = await run({ provider, config, signal: ctl.signal });
    expect(r.status).toBe("cancelled");
    expect(mock.calls).toHaveLength(2);
    expect(r.decisions.map((d) => d.suggestionId)).toEqual([SUGGESTIONS[0]!.id, SUGGESTIONS[1]!.id]);
  });

  it("a provider that ignores its signal still cannot hold the run past the timeout or a cancel", async () => {
    const provider = new MockAiProvider({ delayMs: 10_000, ignoreSignal: true });
    const config: AiConfig = { ...CONFIG, limits: { ...CONFIG.limits, requestTimeoutMs: 20, maxRetries: 0 } };
    const t0 = Date.now();
    const r = await run({ provider, config });
    expect(r.status).toBe("error");
    expect(r.messages.join(" ")).toContain("לא ענה בזמן");
    expect(Date.now() - t0).toBeLessThan(5_000);

    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    const r2 = await run({ provider: new MockAiProvider({ delayMs: 10_000, ignoreSignal: true }), signal: ctl.signal });
    expect(r2.status).toBe("cancelled");
  });

  it("retries a retryable failure within the limits, honouring Retry-After; an auth failure is not retried", async () => {
    const waits: number[] = [];
    let n = 0;
    const flaky: MockResponder = (_r, _c, cands) => {
      if (++n === 1) throw new AiProviderError("rate-limit", "429", 1234);
      return answer(cands.map((c) => ({ id: c.id, verdict: "reject", option: null, confidence: 0.8, reason: "לא" })));
    };
    const r = await run({ provider: new MockAiProvider({ respond: flaky }), sleep: async (ms) => void waits.push(ms) });
    expect(r.status).toBe("done");
    expect(waits).toEqual([1234]);
    expect(r.usage.requests).toBe(2);
    expect(r.decisions.every((d) => d.verdict === "reject" && d.target === undefined)).toBe(true);

    const auth = new MockAiProvider({ respond: () => { throw new AiProviderError("auth", "401 invalid key"); } });
    const r2 = await run({ provider: auth });
    expect(r2.status).toBe("error");
    expect(auth.calls).toHaveLength(1);
  });
});

describe("AI review: the deterministic validator after every answer", () => {
  const batch = prepareCandidates(SUGGESTIONS.slice(0, 2), "refs", 300);
  const [a, b] = [SUGGESTIONS[0]!, SUGGESTIONS[1]!];

  it("drops a decision about an id that was not sent, and does not echo it", () => {
    const check = validateAiAnswer(JSON.stringify({ decisions: [{ id: "made-up:db:9", verdict: "accept", option: 0, confidence: 1, reason: "x" }, { id: a.id, verdict: "accept", option: 0, confidence: 0.9, reason: "טוב" }] }), batch);
    expect(check.invented).toBe(1);
    expect(check.decisions.map((d) => d.suggestionId)).toEqual([a.id]);
    expect(JSON.stringify(check.rejections)).not.toContain("made-up");
    expect(check.undecided).toEqual([b.id]);
  });

  it("drops a decision that adds a book, a line or a ref of its own (only the engine's places are used)", () => {
    const check = validateAiAnswer(JSON.stringify({ decisions: [{ id: a.id, verdict: "accept", option: 0, confidence: 1, reason: "", book: "שמות", line: 4 }] }), batch);
    expect(check.decisions).toEqual([]);
    expect(check.rejections[0]!.code).toBe("ai/unexpected-field");
  });

  it("maps an accepted option to the engine's own place; an option out of range is dropped", () => {
    const check = validateAiAnswer(JSON.stringify({ decisions: [{ id: a.id, verdict: "accept", option: 1, confidence: 0.7, reason: "החלופה" }, { id: b.id, verdict: "accept", option: 7, confidence: 0.7, reason: "" }] }), batch);
    expect(check.decisions).toHaveLength(1);
    expect(check.decisions[0]!.target).toBe(a.alternatives[0]!.target); // the same object the engine made
    expect(check.decisions[0]!.changedTarget).toBe(true);
    expect(check.rejections.map((r) => r.code)).toEqual(["ai/invalid-option"]);
  });

  it("drops bad JSON, a bad shape, a bad verdict, a confidence out of range and a duplicate", () => {
    expect(validateAiAnswer("Sure! Here you go: {", batch).rejections[0]!.code).toBe("ai/invalid-json");
    expect(validateAiAnswer('[{"id":"x"}]', batch).rejections[0]!.code).toBe("ai/invalid-shape");
    expect(validateAiAnswer('{"decisions":[],"links":[]}', batch).rejections[0]!.code).toBe("ai/invalid-shape");
    const check = validateAiAnswer(
      JSON.stringify({
        decisions: [
          { id: a.id, verdict: "approve", option: 0, confidence: 1, reason: "" },
          { id: a.id, verdict: "accept", option: 0, confidence: 1.5, reason: "" },
          { id: b.id, verdict: "reject", option: null, confidence: 0.2, reason: "לא שייך" },
          { id: b.id, verdict: "accept", option: 0, confidence: 0.9, reason: "" },
        ],
      }),
      batch,
    );
    expect(check.rejections.map((r) => r.code)).toEqual(["ai/invalid-verdict", "ai/invalid-confidence", "ai/duplicate-decision"]);
    expect(check.decisions.map((d) => [d.suggestionId, d.verdict])).toEqual([[b.id, "reject"]]);
  });

  it("accepts the answer wrapped in one ```json fence, and nothing hunted out of prose", () => {
    const body = JSON.stringify({ decisions: [{ id: a.id, verdict: "unsure", option: null, confidence: 0.5, reason: "" }] });
    expect(validateAiAnswer("```json\n" + body + "\n```", batch).decisions).toHaveLength(1);
    expect(validateAiAnswer("Here: " + body, batch).decisions).toHaveLength(0);
  });

  it("the host's isValidTarget has the last word (a line that no longer exists, a heading)", () => {
    const check = validateAiAnswer(JSON.stringify({ decisions: [{ id: a.id, verdict: "accept", option: 0, confidence: 1, reason: "" }] }), batch, (side) => side.line !== a.target.line);
    expect(check.decisions).toEqual([]);
    expect(check.rejections[0]!.code).toBe("ai/invalid-target");
  });

  it("a run with an answer full of invented ids decides nothing about them", async () => {
    const provider = new MockAiProvider({ respond: () => answer([{ id: "dibur-hamatchil:db:1:99->db:3:1", verdict: "accept", option: 0, confidence: 1, reason: "" }]) });
    const r = await run({ provider });
    expect(r.status).toBe("done");
    expect(r.decisions).toEqual([]);
    expect(r.notReviewed).toHaveLength(SUGGESTIONS.length);
    expect(r.rejections.every((x) => x.code === "ai/unknown-candidate")).toBe(true);
  });
});

describe("AI review: requests and key protection", () => {
  it("the same input gives the same request text (reproducible), batched by count and size", () => {
    const p = prepareCandidates(SUGGESTIONS, "refs", 300);
    expect(buildRequest(CONFIG, p)).toEqual(buildRequest(CONFIG, prepareCandidates(SUGGESTIONS, "refs", 300)));
    expect(batchCandidates(p, 2, 1_000_000).batches.map((b) => b.length)).toEqual([2, 2, 1]);
    const one = p[0]!.json.length + '{"candidates":[]}'.length;
    expect(batchCandidates(p, 99, one).batches.map((b) => b.length)).toEqual([1, 1, 1, 1, 1]);
    expect(batchCandidates(p, 99, one - 1).tooLarge).toHaveLength(5);
  });

  it("configured skills are added only for the engines they apply to", () => {
    const p = prepareCandidates(SUGGESTIONS, "refs", 300);
    const config: AiConfig = {
      ...CONFIG,
      skills: [
        { id: "mishnah", title: "משנה", instructions: "RULE-DH", engines: ["dibur-hamatchil"] },
        { id: "cites", title: "מראי מקומות", instructions: "RULE-CIT", engines: ["citations"] },
      ],
    };
    const sys = buildRequest(config, p).system;
    expect(sys).toContain("RULE-DH");
    expect(sys).not.toContain("RULE-CIT");
  });

  it("a config with a key, token or password field is refused; limits are capped", () => {
    const c = checkAiConfig({ enabled: true, providerId: "x", model: "m", apiKey: "sk-123", limits: { maxRequests: 10_000, maxTotalTokens: 5 } });
    expect(c.errors.join(" ")).toContain("apiKey");
    expect(c.errors.join(" ")).toContain("maxRequests");
    expect(c.config.limits.maxRequests).toBe(DEFAULT_AI_CONFIG.limits.maxRequests);
    expect(c.config.limits.maxTotalTokens).toBe(5);
    expect(checkAiConfig({ nested: { access_token: "t" } }).errors).toHaveLength(1);
    expect(checkAiConfig({ limits: { maxOutputTokens: 100 } }).errors).toEqual([]); // "Tokens" in a limit is not a secret
  });

  it("the key never reaches a report, even when the provider's error quotes it", async () => {
    const key = "very-secret-key-123456";
    const provider = new MockAiProvider({ respond: () => { throw new AiProviderError("auth", `401 for key ${key} at https://api.example/v1?key=${key}&x=1, sk-abcdefghijk`); } });
    const r = await run({ provider, secrets: [key] });
    const all = JSON.stringify(r);
    expect(all).not.toContain(key);
    expect(all).not.toContain("sk-abcdefghijk");
    expect(redactSecrets("Authorization: Bearer abc.def.ghi.jkl")).toBe("Authorization: Bearer ***");
    expect(provider.calls.every((c) => !JSON.stringify(c).includes(key))).toBe(true);
  });
});
