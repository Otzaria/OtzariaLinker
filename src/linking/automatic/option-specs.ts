import { checkCustomPattern, type MarkerStyle } from "./footnotes/markers";
import { DEFAULT_THRESHOLDS, type EngineId } from "./types";

/*
 * The engines' user-facing options (advanced mode), described as data so the UI renders them
 * generically and the same description validates what reaches the worker. Only options that make
 * sense to a person are listed; function-valued options (DH `windows`) never cross the worker.
 *
 * Form values are plain strings/numbers/booleans keyed by `key`; `toEngineOptions` turns them into the
 * engine's own option object, dropping anything at its default so a run with untouched settings is
 * byte-identical to a run without them.
 */
export type OptionSpec =
  | { kind: "select"; key: string; label: string; hint?: string; choices: readonly (readonly [value: string, label: string])[]; default: string }
  | { kind: "number"; key: string; label: string; hint?: string; min: number; max: number; step?: number; default: number }
  | { kind: "boolean"; key: string; label: string; hint?: string; default: boolean }
  /** a marker style: a select plus a text field for a custom tag or regular expression */
  | { kind: "marker"; key: string; label: string; hint?: string; default: "auto" };

export type FormValue = string | number | boolean;
export type FormValues = Record<string, FormValue>;

const THRESHOLDS: OptionSpec[] = [
  { kind: "number", key: "t.certain", label: "סף לוודאי (%)", min: 50, max: 100, default: DEFAULT_THRESHOLDS.certain * 100, hint: "ציון שמעליו הצעה נחשבת ודאית ונכללת ב\"אישור כל הוודאיות\"." },
  { kind: "number", key: "t.high", label: "סף לגבוה (%)", min: 30, max: 100, default: DEFAULT_THRESHOLDS.high * 100 },
  { kind: "number", key: "t.possible", label: "סף מינימלי להצעה (%)", min: 10, max: 100, default: DEFAULT_THRESHOLDS.possible * 100, hint: "מתחת לסף הזה השורה נחשבת \"בלי התאמה\"." },
  { kind: "number", key: "t.margin", label: "מרווח לעמימות (%)", min: 0, max: 50, default: DEFAULT_THRESHOLDS.ambiguityMargin * 100, hint: "מועמד שני קרוב יותר מזה לראשון הופך את ההצעה ל\"עמומה\"." },
];

const TYPE_CHOICES = [
  ["", "ברירת המחדל של השיטה"],
  ["source", "מקור"],
  ["commentary", "פירוש"],
  ["targum", "תרגום"],
  ["reference", "הפניה"],
  ["footnotes", "הערות שוליים"],
  ["other", "אחר"],
] as const;

export const ENGINE_OPTION_SPECS: Readonly<Record<EngineId, readonly OptionSpec[]>> = {
  headings: [
    { kind: "select", key: "numbering", label: "קריאת מספרים בכותרות", default: "lenient", choices: [["lenient", "סלחנית (יה, ער, רחצ נקראים)"], ["strict", "מדויקת בלבד"]] },
    { kind: "select", key: "inlineMarkers", label: "מספור \"(יב)\" בתחילת שורות הפירוש", default: "auto", choices: [["auto", "אוטומטי — רק כשהוא מקביל לבסיס"], ["always", "תמיד כרמה העמוקה"], ["never", "אף פעם"]] },
    { kind: "boolean", key: "untaggedHeadings", label: "שורות קצרות כמו \"פרק ג\" נחשבות כותרת גם בלי תגית", default: true },
    { kind: "number", key: "maxAlternatives", label: "מספר חלופות לכל הצעה", min: 0, max: 10, default: 3 },
    { kind: "select", key: "declaredType", label: "סוג הקישור", default: "", choices: TYPE_CHOICES },
    ...THRESHOLDS,
  ],
  "dibur-hamatchil": [
    { kind: "number", key: "maxDhWords", label: "מספר מילים מרבי בדיבור המתחיל", min: 2, max: 30, default: 12 },
    { kind: "select", key: "anchors", label: "עוגן על מילות הד\"ה בבסיס", default: "auto", choices: [["auto", "כשאוצריא תשמור אותו"], ["off", "בלי עוגן"]] },
    { kind: "select", key: "targetStartsWithDh", label: "שורות ספר הבסיס פותחות בד\"ה משלהן", default: "", choices: [["", "זיהוי אוטומטי"], ["yes", "כן (פירוש על פירוש)"], ["no", "לא"]] },
    { kind: "boolean", key: "ladder", label: "הרחבת החיפוש בהדרגה לד\"ה מסומן", default: true },
    { kind: "boolean", key: "ladderWide", label: "חיפוש גם בקטעים הסמוכים בספר הבסיס", default: false, hint: "במדידה על ספרים אמיתיים התאמות שנמצאו רק בקטע סמוך היו שגויות ברוב המקרים." },
    { kind: "boolean", key: "inherit", label: "שורות בא\"ד / שם יורשות את מקום השורה הקודמת", default: true },
    ...THRESHOLDS,
  ],
  footnotes: [
    { kind: "marker", key: "mainMarkers", label: "סימני ההערות בספר", default: "auto", hint: "אוטומטי בודק <sup>, <sub> וסוגריים ובוחר את מה שמתאים לספר ההערות." },
    { kind: "marker", key: "notesMarkers", label: "סימון תחילת הערה בספר ההערות", default: "auto" },
    { kind: "select", key: "notesMarkerPosition", label: "איפה הסימן בשורת ההערה", default: "start", choices: [["start", "רק בתחילת השורה"], ["anywhere", "בכל מקום בשורה"]] },
    { kind: "select", key: "numbering", label: "מספור ההערות", default: "auto", choices: [["auto", "לפי ספר ההערות"], ["digits", "ספרות"], ["letters", "אותיות"], ["any", "שניהם"]] },
    { kind: "select", key: "chapterSplit", label: "איפה מתחילה סדרת מספור חדשה", default: "auto", choices: [["auto", "אוטומטי"], ["reset", "כשהמספור חוזר ל־1"], ["headings", "בכל כותרת"], ["none", "סדרה אחת לכל הספר"]] },
    { kind: "number", key: "headingLevel", label: "רמת הכותרת שמתחילה פרק (0 = כל כותרת)", min: 0, max: 6, default: 0 },
    { kind: "select", key: "chapterAlignment", label: "שיוך הסימנים לפרקים", default: "global", choices: [["global", "גלובלי (מומלץ)"], ["greedy", "סימן אחר סימן (כמו Link-Notes)"]] },
    { kind: "boolean", key: "includeInlineNoteMarkers", label: "לקרוא גם סימנים של הערות שכבר מוטמעות בשורה", default: false },
    { kind: "select", key: "declaredType", label: "סוג הקישור", default: "", choices: TYPE_CHOICES },
  ],
};

/** the text field next to a marker select: `<key>.custom` */
export const customKey = (key: string): string => `${key}.custom`;

export const MARKER_CHOICES = [
  ["auto", "אוטומטי"],
  ["sup", "<sup>"],
  ["sub", "<sub>"],
  ["parentheses", "סוגריים ( )"],
  ["tag", "תגית אחרת"],
  ["regex", "ביטוי רגולרי"],
] as const;

export function defaultFormValues(engine: EngineId): FormValues {
  const out: FormValues = {};
  for (const s of ENGINE_OPTION_SPECS[engine]) {
    out[s.key] = s.default;
    if (s.kind === "marker") out[customKey(s.key)] = "";
  }
  return out;
}

export interface OptionsCheck {
  options: Record<string, unknown>;
  /** problems, keyed by option key; a run must not start while there are any */
  errors: Record<string, string>;
  /** how many options differ from their defaults */
  changed: number;
}

/**
 * Form values → the engine's options. Unknown keys are ignored, numbers are clamped to their range,
 * select values must be one of the choices, and a custom regular expression must pass the same
 * guard the engine applies (checkCustomPattern) — so the worker never sees a value the UI could not show.
 */
export function toEngineOptions(engine: EngineId, values: FormValues): OptionsCheck {
  const options: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  let changed = 0;
  const thresholds = { ...DEFAULT_THRESHOLDS };
  let thresholdsChanged = false;

  for (const spec of ENGINE_OPTION_SPECS[engine]) {
    const raw = values[spec.key];
    if (raw === undefined) continue;
    switch (spec.kind) {
      case "boolean": {
        const v = raw === true || raw === "true";
        if (v !== spec.default) (options[spec.key] = v), changed++;
        break;
      }
      case "number": {
        const n = typeof raw === "number" ? raw : Number(String(raw).trim());
        if (!Number.isFinite(n)) {
          errors[spec.key] = "צריך מספר.";
          break;
        }
        const v = Math.min(spec.max, Math.max(spec.min, n));
        if (v === spec.default) break;
        changed++;
        if (spec.key.startsWith("t.")) {
          thresholdsChanged = true;
          const field = ({ "t.certain": "certain", "t.high": "high", "t.possible": "possible", "t.margin": "ambiguityMargin" } as const)[spec.key as "t.certain"];
          thresholds[field] = v / 100;
        } else options[spec.key] = spec.key === "headingLevel" && v === 0 ? undefined : Math.round(v);
        break;
      }
      case "select": {
        const v = String(raw);
        if (!spec.choices.some(([c]) => c === v)) {
          errors[spec.key] = "ערך לא מוכר.";
          break;
        }
        if (v === spec.default) break;
        changed++;
        options[spec.key] = spec.key === "targetStartsWithDh" ? v === "yes" : v;
        break;
      }
      case "marker": {
        const v = String(raw);
        if (v === "auto") break;
        const custom = String(values[customKey(spec.key)] ?? "").trim();
        let style: MarkerStyle;
        if (v === "sup" || v === "sub" || v === "parentheses") style = v;
        else if (v === "tag") {
          const tag = custom.replace(/[<>/\s]/g, "");
          if (!/^[a-zA-Z][\w-]*$/.test(tag)) {
            errors[spec.key] = "כתבו שם תגית באנגלית, למשל small.";
            break;
          }
          style = { tag };
        } else if (v === "regex") {
          const check = checkCustomPattern(custom);
          if (!check.ok) {
            errors[spec.key] = check.reason;
            break;
          }
          style = { regex: custom };
        } else {
          errors[spec.key] = "ערך לא מוכר.";
          break;
        }
        options[spec.key] = style;
        changed++;
        break;
      }
    }
  }
  if (thresholdsChanged) {
    if (!(thresholds.possible <= thresholds.high && thresholds.high <= thresholds.certain))
      errors["t.certain"] = "הספים צריכים להיות בסדר עולה: מינימלי ≤ גבוה ≤ ודאי.";
    else options.thresholds = thresholds;
  }
  for (const k of Object.keys(options)) if (options[k] === undefined) delete options[k];
  return { options, errors, changed };
}
