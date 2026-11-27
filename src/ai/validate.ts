import type { LinkSide } from "../core/links/model";
import type { PreparedCandidate } from "./request";
import type { AiDecision, AiRejection, AiVerdict } from "./types";

/*
 * The deterministic gate after EVERY model answer (V7 §4.17). The answer is untrusted text; what passes is only:
 * - a decision about a candidate id that was SENT in this request (an invented id is dropped, and not echoed back);
 * - with exactly the fields of AI_ANSWER_SCHEMA (a decision that adds a book, a line or a ref is dropped whole);
 * - for "accept", an option number that exists — mapped back to the ENGINE's place for that option, so the target of
 *   a decision is always one the engine produced, never one the model wrote;
 * - and, when the host passes `isValidTarget`, a place the host still accepts (the line exists, is not a heading…).
 * One decision per candidate; a second one about the same id is dropped. Nothing here calls the model or the network.
 */

const FIELDS = new Set(["id", "verdict", "option", "confidence", "reason"]);
const VERDICTS: readonly AiVerdict[] = ["accept", "reject", "unsure"];
export const MAX_REASON_CHARS = 300;

export interface AnswerCheck {
  readonly decisions: AiDecision[];
  readonly rejections: AiRejection[];
  /** candidate ids of the batch with no valid decision */
  readonly undecided: string[];
  /** how many decisions named an id that was not sent */
  readonly invented: number;
}

/** A place in the engine's own terms is well-formed (a non-negative integer line, an end not before it). */
const wellFormed = (s: LinkSide) => Number.isInteger(s.line) && s.line >= 0 && (s.end === undefined || (Number.isInteger(s.end) && s.end >= s.line));

/** The answer as JSON: the whole text, or the one ```json fence it is wrapped in. Nothing is searched for in prose. */
function parseAnswer(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  return JSON.parse(t);
}

export function validateAiAnswer(text: string, batch: readonly PreparedCandidate[], isValidTarget?: (side: LinkSide) => boolean): AnswerCheck {
  const byId = new Map(batch.map((c) => [c.suggestion.id, c] as const));
  const decisions: AiDecision[] = [];
  const rejections: AiRejection[] = [];
  const decided = new Set<string>();
  let invented = 0;
  const all = () => batch.map((c) => c.suggestion.id);

  let parsed: unknown;
  try {
    parsed = parseAnswer(text);
  } catch {
    rejections.push({ code: "ai/invalid-json", message: "תשובת המודל אינה JSON תקין, ולכן לא נלקחה ממנה אף החלטה." });
    return { decisions, rejections, undecided: all(), invented };
  }
  const list = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).decisions : undefined;
  if (!Array.isArray(list) || Object.keys(parsed as object).some((k) => k !== "decisions")) {
    rejections.push({ code: "ai/invalid-shape", message: 'תשובת המודל אינה במבנה {"decisions": [...]}, ולכן לא נלקחה ממנה אף החלטה.' });
    return { decisions, rejections, undecided: all(), invented };
  }

  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      rejections.push({ code: "ai/invalid-shape", message: "בתשובת המודל יש החלטה שאינה אובייקט; היא נדחתה." });
      continue;
    }
    const d = raw as Record<string, unknown>;
    const id = typeof d.id === "string" ? d.id : undefined;
    const cand = id === undefined ? undefined : byId.get(id);
    if (!cand) {
      // the model named a candidate that was not sent: never act on it, and do not repeat its text
      invented++;
      rejections.push({ code: "ai/unknown-candidate", message: "המודל החזיר החלטה על הצעה שלא נשלחה אליו; ההחלטה נדחתה." });
      continue;
    }
    const sid = cand.suggestion.id;
    const reject = (code: AiRejection["code"], message: string) => rejections.push({ code, suggestionId: sid, message });
    if (decided.has(sid)) {
      reject("ai/duplicate-decision", "המודל החזיר יותר מהחלטה אחת על אותה הצעה; נלקחה הראשונה בלבד.");
      continue;
    }
    const extra = Object.keys(d).filter((k) => !FIELDS.has(k));
    if (extra.length) {
      reject("ai/unexpected-field", `המודל הוסיף להחלטה שדות שאינם מותרים (${extra.join(", ")}); ההחלטה נדחתה כולה, כי מקום לקישור נלקח רק מהמנוע.`);
      continue;
    }
    const verdict = d.verdict as AiVerdict;
    if (!VERDICTS.includes(verdict)) {
      reject("ai/invalid-verdict", "המודל החזיר הכרעה שאינה accept, reject או unsure; ההחלטה נדחתה.");
      continue;
    }
    const confidence = d.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      reject("ai/invalid-confidence", "המודל החזיר ביטחון שאינו מספר בין 0 ל־1; ההחלטה נדחתה.");
      continue;
    }
    if (typeof d.reason !== "string") {
      reject("ai/invalid-reason", "המודל לא החזיר נימוק כטקסט; ההחלטה נדחתה.");
      continue;
    }
    const reason = d.reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
    if (verdict !== "accept") {
      if (d.option !== null && d.option !== undefined) {
        reject("ai/invalid-option", "המודל בחר אפשרות בלי לקבל את ההצעה; ההחלטה נדחתה.");
        continue;
      }
      decided.add(sid);
      decisions.push({ suggestionId: sid, verdict, changedTarget: false, confidence, reason });
      continue;
    }
    const option = d.option;
    if (typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= cand.places.length) {
      reject("ai/invalid-option", `המודל בחר אפשרות שאינה ברשימה (יש ${cand.places.length}); ההחלטה נדחתה.`);
      continue;
    }
    const target = cand.places[option]!;
    if (!wellFormed(target) || (isValidTarget && !isValidTarget(target))) {
      reject("ai/invalid-target", "המקום שהמודל בחר אינו תקין עוד (השורה אינה קיימת, או שאי אפשר לקשר אליה); ההחלטה נדחתה.");
      continue;
    }
    decided.add(sid);
    decisions.push({ suggestionId: sid, verdict, option, target, changedTarget: option !== 0, confidence, reason });
  }
  return { decisions, rejections, undecided: batch.map((c) => c.suggestion.id).filter((id) => !decided.has(id)), invented };
}
