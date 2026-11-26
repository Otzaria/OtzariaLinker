import { DEFAULT_AI_CONFIG, DEFAULT_AI_LIMITS, type AiConfig, type AiConsent, type AiDataScope, type AiLimits, type AiSkill } from "./types";
import type { EngineId } from "../linking/automatic/types";

/*
 * Reading an AI config from JSON (a CLI flag file, a plugin's settings), with the safety rules in one place:
 * - a field that looks like a secret (key, token, secret, password) is refused: the key belongs to the provider, read by
 *   the host from the environment, and must never sit in a file that is shared or saved with a project;
 * - every limit is a positive integer and is capped, so a typo cannot turn a run into an unbounded one;
 * - `enabled` is true only when written as `true`.
 */

const SECRET_WORDS = new Set(["key", "apikey", "token", "secret", "password", "passwd", "authorization", "bearer", "credential", "credentials"]);
/** a field name is a secret when one of its words is (apiKey, api_key, x-api-key, accessToken); "maxTotalTokens" is not */
const isSecretField = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => SECRET_WORDS.has(w));
const ENGINES: readonly EngineId[] = ["headings", "footnotes", "dibur-hamatchil", "citations", "pattern"];
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_SKILL_CHARS = 2_000;
export const MAX_SKILLS = 20;

/** the ceiling of each limit (a config may lower a limit, never lift it past these) */
export const AI_LIMIT_CAPS: AiLimits = {
  maxRequests: 500,
  maxCandidatesPerRequest: 100,
  maxInputCharsPerRequest: 200_000,
  maxTotalTokens: 5_000_000,
  maxOutputTokens: 32_000,
  requestTimeoutMs: 300_000,
  maxRetries: 5,
  maxSnippetChars: 2_000,
};

export interface AiConfigCheck {
  readonly config: AiConfig;
  /** Hebrew; empty when the config is usable */
  readonly errors: readonly string[];
}

/** Every key path in `value` whose last name looks like a secret. */
export function secretFields(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (isSecretField(k)) out.push(p);
    out.push(...secretFields(v, p));
  }
  return out;
}

export function checkAiConfig(raw: unknown): AiConfigCheck {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: DEFAULT_AI_CONFIG, errors: ["הגדרות הבינה המלאכותית אינן אובייקט JSON. כתבו אובייקט עם השדות enabled, providerId ו־model."] };
  }
  const secrets = secretFields(raw);
  if (secrets.length) {
    errors.push(`בהגדרות יש שדה שנראה כמפתח או סיסמה (${secrets.join(", ")}). מחקו אותו: המפתח נקרא ממשתנה סביבה של הספק בלבד, ולא נשמר בקובץ הגדרות או בפרויקט.`);
  }
  const r = raw as Record<string, unknown>;
  const str = (name: string): string => {
    const v = r[name];
    if (v === undefined) return "";
    if (typeof v !== "string") errors.push(`השדה ${name} צריך להיות טקסט.`);
    return typeof v === "string" ? v.trim() : "";
  };
  const enabled = r.enabled === true;
  const providerId = str("providerId");
  const model = str("model");
  if (enabled && !providerId) errors.push("לא נבחר ספק (providerId). בחרו ספק, או כבו את הבדיקה (enabled: false).");
  if (enabled && !model) errors.push("לא נבחר מודל (model). בחרו מודל מהרשימה של הספק.");
  let scope: AiDataScope = "refs";
  if (r.scope !== undefined) {
    if (r.scope === "refs" || r.scope === "refs+text") scope = r.scope;
    else errors.push('השדה scope יכול להיות "refs" (בלי טקסט הספרים) או "refs+text" (עם קטע קצר מכל שורה).');
  }
  return {
    config: { enabled, providerId, model, scope, skills: readSkills(r.skills, errors), limits: readLimits(r.limits, errors) },
    errors,
  };
}

function readLimits(raw: unknown, errors: string[]): AiLimits {
  if (raw === undefined) return DEFAULT_AI_LIMITS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("השדה limits צריך להיות אובייקט.");
    return DEFAULT_AI_LIMITS;
  }
  const out: Record<string, number> = { ...DEFAULT_AI_LIMITS };
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in DEFAULT_AI_LIMITS)) {
      errors.push(`מגבלה לא מוכרת: ${k}.`);
      continue;
    }
    const cap = AI_LIMIT_CAPS[k as keyof AiLimits];
    const min = k === "maxRetries" ? 0 : 1;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > cap) {
      errors.push(`המגבלה ${k} צריכה להיות מספר שלם בין ${min} ל־${cap}.`);
      continue;
    }
    out[k] = v;
  }
  return out as unknown as AiLimits;
}

function readSkills(raw: unknown, errors: string[]): AiSkill[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push("השדה skills צריך להיות רשימה.");
    return [];
  }
  if (raw.length > MAX_SKILLS) errors.push(`יותר מ־${MAX_SKILLS} כללים (skills). השאירו את החשובים.`);
  const out: AiSkill[] = [];
  const seen = new Set<string>();
  for (const s of raw.slice(0, MAX_SKILLS)) {
    const o = (s ?? {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!SKILL_ID.test(id) || seen.has(id)) {
      errors.push(`לכלל יש מזהה לא תקין או כפול (${id || "ריק"}). מזהה: אותיות לטיניות קטנות, ספרות ומקף.`);
      continue;
    }
    const instructions = typeof o.instructions === "string" ? o.instructions.trim() : "";
    if (!instructions || instructions.length > MAX_SKILL_CHARS) {
      errors.push(`בכלל ${id} ההוראות ריקות או ארוכות מ־${MAX_SKILL_CHARS} תווים.`);
      continue;
    }
    let engines: EngineId[] | undefined;
    if (o.engines !== undefined) {
      if (!Array.isArray(o.engines) || !o.engines.every((e) => ENGINES.includes(e as EngineId))) {
        errors.push(`בכלל ${id} רשימת המנועים (engines) אינה תקינה. אפשר: ${ENGINES.join(", ")}.`);
        continue;
      }
      engines = o.engines as EngineId[];
    }
    seen.add(id);
    out.push({ id, title: typeof o.title === "string" ? o.title.trim() : id, instructions, ...(engines ? { engines } : {}) });
  }
  return out;
}

/** Whether `consent` covers what `config` would send. "refs+text" covers "refs"; nothing covers another provider. */
export function consentCovers(consent: AiConsent | null | undefined, config: AiConfig): boolean {
  if (!consent || consent.providerId !== config.providerId) return false;
  return consent.scope === "refs+text" || config.scope === "refs";
}
