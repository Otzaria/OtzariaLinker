import type { LinkSide } from "../core/links/model";
import type { EngineId, Suggestion } from "../linking/automatic/types";
import type { AiCandidate, AiConfig, AiDataScope, AiOption, AiRequest, AiSkill, JsonSchema, TextLookup } from "./types";

/*
 * What is sent to a model, built deterministically (the same suggestions and config give the same request text), so a
 * run can be reproduced, cached and audited. Only what `scope` allows is in it: in "refs" no line text at all.
 */

/** The answer's shape. Closed objects: a field the model adds (a book, a line) makes the decision invalid. */
export const AI_ANSWER_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "option", "confidence", "reason"],
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["accept", "reject", "unsure"] },
          option: { type: ["integer", "null"], minimum: 0 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string", maxLength: 300 },
        },
      },
    },
  },
};

const BASE_RULES = [
  "You review candidate links between Hebrew books, proposed by deterministic engines for the Otzaria library.",
  "Each candidate has an id, a source line and numbered options (option 0 is the engine's choice, the others are its alternatives).",
  "For every candidate decide: accept (and give the option number), reject (none of the options is right) or unsure.",
  "You may ONLY use the ids and the option numbers given. Never name a book, a line or a reference of your own, and never add fields.",
  "If you are not sure, answer unsure. A wrong link is worse than a missing one.",
  "Answer with JSON only, matching the response schema: {\"decisions\":[{\"id\",\"verdict\",\"option\",\"confidence\",\"reason\"}]}. option is null unless verdict is accept. reason: one short sentence in Hebrew.",
];

/** The instructions: the fixed rules, then the configured skills that apply to these engines (sorted by id, so stable). */
export function buildSystemPrompt(skills: readonly AiSkill[], engines: ReadonlySet<EngineId>): string {
  const applying = skills
    .filter((s) => !s.engines || s.engines.some((e) => engines.has(e)))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parts = [BASE_RULES.join("\n")];
  for (const s of applying) parts.push(`Rule "${s.id}" (${s.title}):\n${s.instructions}`);
  return parts.join("\n\n");
}

/** A line as plain text, for a snippet: tags removed, entities left as they are, whitespace collapsed, cut to `max`. */
export function snippet(html: string, max: number): string {
  const t = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The candidate as sent, and the engine's places behind its options (kept here; never sent). */
export interface PreparedCandidate {
  readonly suggestion: Suggestion;
  readonly sent: AiCandidate;
  /** option N → the engine's place for it */
  readonly places: readonly LinkSide[];
  /** the candidate's JSON, for the size of a request */
  readonly json: string;
}

export function prepareCandidates(suggestions: readonly Suggestion[], scope: AiDataScope, maxSnippetChars: number, text?: TextLookup): PreparedCandidate[] {
  // "refs" sends no text even when the host passed a lookup: the consent decides, not the caller
  const read = scope === "refs+text" && text ? (side: LinkSide) => {
    const t = text(side);
    return t === undefined ? undefined : snippet(t, maxSnippetChars);
  } : () => undefined;
  return suggestions.map((s) => {
    const places: LinkSide[] = [s.target, ...s.alternatives.map((a) => a.target)];
    const options: AiOption[] = places.map((side, i) => {
      const t = read(side);
      const heRef = i === 0 ? s.heRef2 : undefined;
      return {
        option: i,
        book: side.book.title,
        line: side.line + 1,
        ...(heRef ? { heRef } : {}),
        ...(t !== undefined ? { text: t } : {}),
        score: round3(i === 0 ? s.score : s.alternatives[i - 1]!.score),
      };
    });
    const sourceText = read(s.source);
    const sent: AiCandidate = {
      id: s.id,
      engine: s.engine,
      type: s.declaredType,
      confidence: s.confidence,
      source: { book: s.source.book.title, line: s.source.line + 1, ...(sourceText !== undefined ? { text: sourceText } : {}) },
      // a reason's sentence may quote the book ("ההפניה בטקסט: …"); in "refs" only its stable code is sent
      reasons: s.reasons.map((r) => (scope === "refs+text" ? r.text : r.code)),
      options,
    };
    return { suggestion: s, sent, places, json: JSON.stringify(sent) };
  });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The user message of a request: the candidates as one JSON object. */
export function userMessage(batch: readonly PreparedCandidate[]): string {
  return JSON.stringify({ candidates: batch.map((c) => c.sent) });
}

export function buildRequest(config: AiConfig, batch: readonly PreparedCandidate[]): AiRequest {
  return {
    model: config.model,
    system: buildSystemPrompt(config.skills, new Set(batch.map((c) => c.suggestion.engine))),
    user: userMessage(batch),
    responseSchema: AI_ANSWER_SCHEMA,
    maxOutputTokens: config.limits.maxOutputTokens,
  };
}

/**
 * A conservative token estimate, the same on every machine: a non-ASCII character (Hebrew) as one token, ASCII as a
 * quarter. Used for the budget before a request, and in place of a provider that reports no usage.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) (text.charCodeAt(i) < 128 ? ascii++ : other++);
  return other + Math.ceil(ascii / 4);
}

/**
 * Splits the candidates into requests by count and by size, in order. A candidate larger than a whole request alone is
 * returned in `tooLarge` and never sent.
 */
export function batchCandidates(all: readonly PreparedCandidate[], maxCount: number, maxChars: number): { batches: PreparedCandidate[][]; tooLarge: PreparedCandidate[] } {
  const batches: PreparedCandidate[][] = [];
  const tooLarge: PreparedCandidate[] = [];
  const overhead = '{"candidates":[]}'.length;
  let cur: PreparedCandidate[] = [];
  let size = overhead;
  for (const c of all) {
    if (overhead + c.json.length > maxChars) {
      tooLarge.push(c);
      continue;
    }
    const add = c.json.length + (cur.length ? 1 : 0);
    if (cur.length && (cur.length >= maxCount || size + add > maxChars)) {
      batches.push(cur);
      cur = [];
      size = overhead;
    }
    size += c.json.length + (cur.length ? 1 : 0);
    cur.push(c);
  }
  if (cur.length) batches.push(cur);
  return { batches, tooLarge };
}
