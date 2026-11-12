import { checkCustomPattern } from "../../core/text/safe-regex";
import type { MarkerStyle } from "./footnotes/markers";
import { compilePattern, CUSTOM_PRESET, DEFAULT_PRESET, describeLevels, PATTERN_PRESETS, presetById } from "./pattern";
import { DEFAULT_THRESHOLDS, type EngineId } from "./types";

/*
 * The engines' user-facing options (advanced mode), described as data so the UI renders them
 * generically and the same description validates what reaches the worker. Only options that make
 * sense to a person are listed; function-valued options (DH `windows`) never cross the worker.
 *
 * An ESSENTIAL option is part of the method itself (the pattern of "לפי תבנית"): it is shown and passed
 * in simple mode too; every other option is advanced mode only.
 *
 * Form values are plain strings/numbers/booleans keyed by `key`; `toEngineOptions` turns them into the
 * engine's own option object, dropping anything at its default so a run with untouched settings is
 * byte-identical to a run without them.
 */
interface SpecBase {
  key: string;
  label: string;
  hint?: string;
  /** shown and passed in simple mode too (see above) */
  essential?: boolean;
  /** essential only while another option has this value (the pattern of "לפי תבנית" when the preset is "custom") */
  essentialWhen?: { readonly key: string; readonly value: string };
  /** a hint that depends on the form (the examples of the chosen preset) */
  hintOf?: (values: FormValues) => string | null;
  /** options cleared when this one changes (a new preset drops the pattern edited from the previous one) */
  resets?: readonly string[];
}

export type OptionSpec =
  | (SpecBase & { kind: "select"; choices: readonly (readonly [value: string, label: string])[]; default: string })
  | (SpecBase & { kind: "number"; min: number; max: number; step?: number; default: number })
  | (SpecBase & { kind: "boolean"; default: boolean })
  /** a marker style: a select plus a text field for a custom tag or regular expression */
  | (SpecBase & { kind: "marker"; default: "auto" })
  /**
   * a regular expression, checked by the same guard the engine applies. `template`: a pattern template
   * with placeholders (pattern/template.ts); `defaultOf`: the value shown while the field is empty
   * (the chosen preset's template), which is not passed on.
   */
  | (SpecBase & { kind: "regex"; default: string; template?: boolean; defaultOf?: (values: FormValues) => string });

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
  citations: [
    { kind: "select", key: "minConfidence", label: "ודאות מינימלית להצעה", default: "possible", choices: [["possible", "אפשרית ומעלה"], ["high", "גבוהה ומעלה"], ["certain", "ודאית בלבד"]], hint: "הצעות בוודאות נמוכה יותר לא יוצגו כלל." },
    { kind: "boolean", key: "ibid", label: 'לפענח "שם" לפי ההפניה הקודמת', default: true },
    { kind: "boolean", key: "ranges", label: "הפניה לפרק או לדף שלם מקושרת לכל השורות שלו", default: true, hint: "בלי הסימון הקישור הוא לשורה הראשונה בלבד." },
    { kind: "select", key: "anchors", label: "עוגן על מילות ההפניה", default: "auto", choices: [["auto", "כשאוצריא תשמור אותו"], ["off", "בלי עוגן"]] },
    { kind: "select", key: "scope", label: "לאילו ספרים לקשר", default: "all", choices: [["all", "כל הספרים הפתוחים"], ["classic", 'תנ"ך, משנה, ש"ס, רמב"ם, טור ושולחן ערוך בלבד']] },
    { kind: "number", key: "maxAlternatives", label: "מספר חלופות לכל הצעה", min: 0, max: 10, default: 3 },
    ...THRESHOLDS,
  ],
  pattern: [
    {
      kind: "select",
      key: "preset",
      label: "מה מחפשים",
      default: DEFAULT_PRESET,
      essential: true,
      choices: [...PATTERN_PRESETS.map((p) => [p.id, p.examples[0] ? `${p.name} — "${p.examples[0][0]}"` : p.name] as const), [CUSTOM_PRESET, "תבנית משלכם"]],
      hintOf: (v) => presetHint(String(v["preset"] ?? DEFAULT_PRESET)),
      resets: ["regex"],
    },
    { kind: "select", key: "tag", label: "איפה המספר", default: "", essential: true, choices: [["", "לפי התבנית"], ["sup", "בתוך <sup> (כמו \"לפי תגיות\" בגרסה 3)"], ["sub", "בתוך <sub>"], ["small", "בתוך <small>"], ["b", "בתוך <b>"], ["span", "בתוך <span>"]] },
    {
      kind: "regex",
      key: "regex",
      label: "התבנית (ביטוי רגולרי)",
      default: "",
      template: true,
      essentialWhen: { key: "preset", value: CUSTOM_PRESET },
      defaultOf: (v) => presetById(String(v["preset"] ?? DEFAULT_PRESET))?.template ?? "",
      hintOf: (v) => {
        const levels = describeLevels(String(v["regex"] || presetById(String(v["preset"] ?? DEFAULT_PRESET))?.template || ""));
        return levels ? `רמות: ${levels}. ` + PLACEHOLDER_HINT : PLACEHOLDER_HINT;
      },
    },
    { kind: "select", key: "target", label: "לאן ההפניה מצביעה", default: "", essential: true, choices: [["", "לפי התבנית שנבחרה"], ["tree", "מקום בעץ הכותרות של היעד (סימן › סעיף › ס\"ק)"], ["line", "מספר שורה ביעד"], ["chapter-line", "מספר שורה בתוך הפרק (המספור מתחיל מחדש בכל פרק)"]] },
    { kind: "select", key: "position", label: "איפה בשורה", default: "anywhere", choices: [["anywhere", "בכל מקום"], ["start", "רק בתחילת השורה (פירוש שכל דיבור בו פותח במקומו)"]] },
    { kind: "boolean", key: "carry", label: "שורה בלי הפניה ממשיכה את ההפניה שמעליה (עד הכותרת הבאה)", default: false },
    { kind: "boolean", key: "context", label: "הפניה חלקית (\"ס\"ק ב\") מושלמת מהכותרות של שורת המקור", default: true },
    { kind: "boolean", key: "otherBooks", label: "לדלג על הפניה אחרי שם של ספר אחר (\"הט\"ז ס\"ק ג\", \"שבת דף כג\")", default: true },
    { kind: "boolean", key: "gematria", label: "לקרוא אותיות כמספר (יב = 12)", default: true },
    { kind: "select", key: "matches", label: "כמה התאמות בכל שורה", default: "", choices: [["", "לפי התבנית"], ["first", "הראשונה בלבד"], ["all", "כולן"]] },
    { kind: "boolean", key: "sectionRanges", label: "לקשר לכל הסעיף שתחתיה ההפניה מצביעה (טווח)", default: false },
    { kind: "select", key: "anchors", label: "עוגן על המילים שנמצאו", default: "auto", choices: [["auto", "כשאוצריא תשמור אותו"], ["off", "בלי עוגן"]] },
    { kind: "select", key: "declaredType", label: "סוג הקישור", default: "", choices: TYPE_CHOICES },
    ...THRESHOLDS,
  ],
};

const PLACEHOLDER_HINT = "מקומות שמורים: {סימן} {סעיף} {ס\"ק} {פרק} {הלכה} {משנה} {פסוק} {דף} {עמוד} {אות} {הערה} {מספר} {עד} {שם_ספר} {שם}. בלעדיהם, המספר שבסוגריים הראשונים הוא מספר.";

/** "פרק ומשנה: …; למשל "פ"ב מ"ג" → פרק ב › משנה ג" */
function presetHint(id: string): string | null {
  if (id === CUSTOM_PRESET) return "כתבו תבנית למטה. כל מקום שמור כמו {סימן} הוא רמה בעץ הכותרות של היעד.";
  const p = presetById(id);
  if (!p) return null;
  const ex = p.examples.slice(0, 3).map(([t, path]) => `"${t}" ← ${path}`).join(" · ");
  return ex ? `${p.description}. למשל: ${ex}` : p.description;
}

/** essential now: always, or while the option it depends on has its value */
export function isEssential(spec: OptionSpec, values: FormValues): boolean {
  return spec.essential === true || (spec.essentialWhen !== undefined && String(values[spec.essentialWhen.key] ?? "") === spec.essentialWhen.value);
}

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
export function toEngineOptions(engine: EngineId, values: FormValues, scope: "all" | "essential" = "all"): OptionsCheck {
  const options: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  let changed = 0;
  const thresholds = { ...DEFAULT_THRESHOLDS };
  let thresholdsChanged = false;

  for (const spec of ENGINE_OPTION_SPECS[engine]) {
    if (scope === "essential" && !isEssential(spec, values)) continue;
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
      case "regex": {
        const v = String(raw).trim();
        const shown = spec.defaultOf?.(values) ?? "";
        if (spec.template && (!v || v === shown)) {
          if (!shown && isEssential(spec, values)) errors[spec.key] = "כתבו תבנית, או בחרו תבנית מוכנה ב\"מה מחפשים\".";
          break;
        }
        const check = spec.template ? compilePattern(v) : checkCustomPattern(v);
        if (!check.ok) {
          errors[spec.key] = check.reason;
          break;
        }
        if (v === spec.default) break;
        options[spec.key] = v;
        changed++;
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
