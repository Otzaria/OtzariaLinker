import { inlineLinkerVersionNote } from "../../core/links/connection-type";
import { checkCustomPattern } from "../../core/text/safe-regex";
import type { MarkerStyle } from "./footnotes/markers";
import { compilePattern, CUSTOM_PRESET, DEFAULT_PRESET, describeLevels, PATTERN_PRESETS, presetById } from "./pattern";
import { compileSourceFilter, parseSourceFilter, SOURCE_FILTER_PRESETS, type SourceFilter, type SourceFilterPreset } from "./source-filter";
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
  /** shown only while this holds (the regular expression of the line filter while the filter is a pattern of your own) */
  showWhen?: (values: FormValues) => boolean;
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

/**
 * The source filter (issue #27, source-filter.ts) as form fields: which lines of the source enter the engine, and whether the marker in front
 * of them is ignored when matching. The lineFilter keys are not engine options by themselves: toEngineOptions turns them into ONE option,
 * sourceFilter, and sanitizeStoredOptions reads that back. stripDefault is what the engine does when nobody says (dibur-hamatchil reads the
 * words after the marker; the others read the line as it is).
 */
export const LINE_FILTER_CHOICES: readonly (readonly [string, string])[] = [
  ["", "כל השורות"],
  ["square", "רק שורות שמתחילות ב־[א]"],
  ["round", "רק שורות שמתחילות ב־(א)"],
  ["close-paren", "רק שורות שמתחילות ב־א)"],
  ["bold-dh", 'רק שורות שמתחילות ב־<b>ד"ה</b>'],
  ["regex", "רק שורות שמתחילות בסימן משלכם (ביטוי רגולרי)"],
];
function lineFilterSpecs(stripDefault: boolean, essential: boolean): OptionSpec[] {
  const on = (v: FormValues) => String(v["lineFilter"] ?? "") !== "";
  return [
    {
      kind: "select",
      key: "lineFilter",
      label: "אילו שורות של הספר המקשר נכנסות",
      default: "",
      choices: LINE_FILTER_CHOICES,
      ...(essential && { essential: true }),
      hint: "למשל קישור רק לשורות שמתחילות ב־[א]. ההתאמה נעשית לפי המילים שאחרי הסימן, והקישור והעוגן נשארים על השורה המקורית. בלי סימן כל השורות נכנסות.",
    },
    {
      kind: "regex",
      key: "lineFilterRegex",
      label: "הסימן בתחילת השורה (ביטוי רגולרי)",
      default: "",
      essentialWhen: { key: "lineFilter", value: "regex" },
      showWhen: (v) => String(v["lineFilter"] ?? "") === "regex",
      hint: "הביטוי מתאים לתחילת השורה בלבד (אחרי רווחים ותגיות). למשל {\\d+} ל־{12}. ביטוי שעלול להקפיא את הכלי נדחה.",
    },
    { kind: "boolean", key: "lineFilterExclude", label: "הפוך: לדלג על השורות שמתחילות בסימן", default: false, showWhen: on },
    { kind: "boolean", key: "lineFilterStrip", label: "להתאים לפי המילים שאחרי הסימן (הסימן עצמו לא נחשב)", default: stripDefault, showWhen: on },
  ];
}
const isLineFilterKey = (key: string) => key.startsWith("lineFilter");

export const ENGINE_OPTION_SPECS: Readonly<Record<EngineId, readonly OptionSpec[]>> = {
  headings: [
    { kind: "select", key: "numbering", label: "קריאת מספרים בכותרות", default: "lenient", choices: [["lenient", "סלחנית (יה, ער, רחצ נקראים)"], ["strict", "מדויקת בלבד"]] },
    { kind: "select", key: "inlineMarkers", label: "מספור \"(יב)\" בתחילת שורות הפירוש", default: "auto", choices: [["auto", "אוטומטי — רק כשהוא מקביל לבסיס"], ["always", "תמיד כרמה העמוקה"], ["never", "אף פעם"]] },
    { kind: "boolean", key: "untaggedHeadings", label: "שורות קצרות כמו \"פרק ג\" נחשבות כותרת גם בלי תגית", default: true },
    { kind: "number", key: "maxAlternatives", label: "מספר חלופות לכל הצעה", min: 0, max: 10, default: 3 },
    { kind: "select", key: "declaredType", label: "סוג הקישור", default: "", choices: TYPE_CHOICES },
    ...lineFilterSpecs(false, false),
    ...THRESHOLDS,
  ],
  "dibur-hamatchil": [
    ...lineFilterSpecs(true, true),
    { kind: "number", key: "maxDhWords", label: "מספר מילים מרבי בדיבור המתחיל", min: 2, max: 30, default: 12 },
    { kind: "select", key: "anchors", label: "עוגן על מילות הד\"ה בבסיס", default: "auto", choices: [["auto", "כשאוצריא תשמור אותו"], ["off", "בלי עוגן"]] },
    { kind: "select", key: "targetStartsWithDh", label: "שורות ספר הבסיס פותחות בד\"ה משלהן", default: "", choices: [["", "זיהוי אוטומטי"], ["yes", "כן (פירוש על פירוש)"], ["no", "לא"]] },
    { kind: "boolean", key: "ladder", label: "הרחבת החיפוש בהדרגה לד\"ה מסומן", default: true },
    { kind: "boolean", key: "ladderWide", label: "חיפוש גם בקטעים הסמוכים בספר הבסיס", default: false, hint: "במדידה על ספרים אמיתיים התאמות שנמצאו רק בקטע סמוך היו שגויות ברוב המקרים." },
    { kind: "boolean", key: "inherit", label: "שורות בא\"ד / שם יורשות את מקום השורה הקודמת", default: true },
    { kind: "boolean", key: "intermediates", label: "שורה על רש\"י/תוספות מקושרת רק לספר של אותו מפרש", default: true, hint: "שורה שפותחת \"רש\"י ד\"ה\" או \"תוס' ד\"ה\" מפרשת את דברי המפרש, ולא את הגמרא." },
    { kind: "boolean", key: "continueItems", label: "פסקאות בלי ד\"ה יורשות את מקום הד\"ה שלפניהן", default: true },
    { kind: "boolean", key: "order", label: "הסרת התאמות שאינן בסדר של הפירוש", default: true, hint: "במדידה על ספרים אמיתיים התאמה שאינה מתיישבת עם סדר השורות שסביבה הייתה שגויה ברוב המקרים." },
    ...THRESHOLDS,
  ],
  footnotes: [
    { kind: "marker", key: "mainMarkers", label: "סימני ההערות בספר", default: "auto", essential: true, hint: "אוטומטי בודק <sup>, <sub> וסוגריים, ורק אם אף אחד מהם לא מתאים — גם מספרים צמודים למילה (שלום1). אם ההערות הן מספרים בלי תגית, בחרו \"מספרים בלי תגית\"." },
    { kind: "marker", key: "notesMarkers", label: "סימון תחילת הערה בספר ההערות", default: "auto" },
    { kind: "select", key: "notesMarkerPosition", label: "איפה הסימן בשורת ההערה", default: "start", choices: [["start", "רק בתחילת השורה"], ["anywhere", "בכל מקום בשורה"]] },
    { kind: "select", key: "numbering", label: "מספור ההערות", default: "auto", choices: [["auto", "לפי ספר ההערות"], ["digits", "ספרות"], ["letters", "אותיות"], ["any", "שניהם"]] },
    { kind: "select", key: "chapterSplit", label: "איפה מתחילה סדרת מספור חדשה", default: "auto", choices: [["auto", "אוטומטי"], ["reset", "כשהמספור חוזר ל־1"], ["headings", "בכל כותרת"], ["none", "סדרה אחת לכל הספר"]] },
    { kind: "number", key: "headingLevel", label: "רמת הכותרת שמתחילה פרק (0 = כל כותרת)", min: 0, max: 6, default: 0 },
    { kind: "select", key: "chapterAlignment", label: "שיוך הסימנים לפרקים", default: "global", choices: [["global", "גלובלי (מומלץ)"], ["greedy", "סימן אחר סימן (כמו Link-Notes)"]] },
    { kind: "boolean", key: "includeInlineNoteMarkers", label: "לקרוא גם סימנים של הערות שכבר מוטמעות בשורה", default: false },
    { kind: "select", key: "declaredType", label: "סוג הקישור", default: "", choices: TYPE_CHOICES },
    ...lineFilterSpecs(false, false),
  ],
  citations: [
    { kind: "select", key: "minConfidence", label: "ודאות מינימלית להצעה", default: "possible", choices: [["possible", "אפשרית ומעלה"], ["high", "גבוהה ומעלה"], ["certain", "ודאית בלבד"]], hint: "הצעות בוודאות נמוכה יותר לא יוצגו כלל." },
    { kind: "boolean", key: "ibid", label: 'לפענח "שם" לפי ההפניה הקודמת', default: true },
    { kind: "boolean", key: "ranges", label: "הפניה לפרק או לדף שלם מקושרת לכל השורות שלו", default: true, hint: "בלי הסימון הקישור הוא לשורה הראשונה בלבד." },
    { kind: "select", key: "anchors", label: "עוגן על מילות ההפניה", default: "auto", choices: [["auto", "כשאוצריא תשמור אותו"], ["off", "בלי עוגן"]] },
    {
      kind: "select",
      key: "citationType",
      label: "סוג הקישור",
      default: "reference",
      choices: [["reference", "הפניה (מתאים גם לספרייה)"], ["inline-linker", "ציטוט בטקסט (לשימוש פרטי בלבד)"]],
      hint: 'ציטוט בטקסט נפתח בלחיצה על מילות ההפניה, גם בספר של ספריא. הסוג מוכר רק לייבוא האישי של אוצריא, ולכן בייצוא לספרייה הוא יוחזק: ייצאו אותו בבחירה "לשימוש פרטי". ' + inlineLinkerVersionNote(),
    },
    { kind: "select", key: "scope", label: "לאילו ספרים לקשר", default: "all", choices: [["all", "כל הספרים הפתוחים"], ["classic", 'תנ"ך, משנה, ש"ס, רמב"ם, טור ושולחן ערוך בלבד']] },
    { kind: "number", key: "maxAlternatives", label: "מספר חלופות לכל הצעה", min: 0, max: 10, default: 3 },
    { kind: "boolean", key: "noGate", label: "להריץ גם על ספר בלי סימני הפניה", default: false, hint: "השיטה מדלגת על ספר שאין בו שורה עם דף, פרק, סימן, סעיף או פסוק ומספר (ולא עשר שורות שמזכירות מקום). ספר שמצטט רק בשם הספר ובמספרים (\"בראשית א, ב\") ייתכן שיידלג בטעות." },
    // the line filter is the run's (findings #40 A1): the worker applies it to the citing book (workers/citations-job.ts)
    ...lineFilterSpecs(false, false),
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
    ...lineFilterSpecs(false, false),
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

/** shown in the form now (an option with showWhen is hidden while its condition does not hold) */
export const isShown = (spec: OptionSpec, values: FormValues): boolean => spec.showWhen === undefined || spec.showWhen(values);

/** the text field next to a marker select: `<key>.custom` */
export const customKey = (key: string): string => `${key}.custom`;

export const MARKER_CHOICES = [
  ["auto", "אוטומטי"],
  ["sup", "<sup>"],
  ["sub", "<sub>"],
  ["parentheses", "סוגריים ( )"],
  ["digits", "מספרים בלי תגית (שלום1)"],
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
    if (isLineFilterKey(spec.key)) continue; // composed into one option below
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
        if (v === "sup" || v === "sub" || v === "parentheses" || v === "digits") style = v;
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
  const filter = lineFilterOption(engine, values, scope, errors);
  if (filter) (options["sourceFilter"] = filter), changed++;
  if (thresholdsChanged) {
    if (!(thresholds.possible <= thresholds.high && thresholds.high <= thresholds.certain))
      errors["t.certain"] = "הספים צריכים להיות בסדר עולה: מינימלי ≤ גבוה ≤ ודאי.";
    else options.thresholds = thresholds;
  }
  for (const k of Object.keys(options)) if (options[k] === undefined) delete options[k];
  return { options, errors, changed };
}

/** The lineFilter fields as the engine option sourceFilter (null: no filter), with the problems of the fields in errors. */
function lineFilterOption(engine: EngineId, values: FormValues, scope: "all" | "essential", errors: Record<string, string>): SourceFilter | null {
  const specs = ENGINE_OPTION_SPECS[engine];
  const get = (key: string) => specs.find((x) => x.key === key);
  const filterSpec = get("lineFilter");
  if (!filterSpec || (scope === "essential" && !isEssential(filterSpec, values))) return null;
  const choice = String(values["lineFilter"] ?? "");
  if (!choice) return null;
  const used = (key: string) => {
    const sp = get(key);
    return !!sp && (scope === "all" || isEssential(sp, values));
  };
  let prefix: SourceFilter["prefix"];
  if (choice === "regex") {
    const rx = String(values["lineFilterRegex"] ?? "").trim();
    const check = compileSourceFilter({ prefix: { regex: rx } });
    if (!check.ok) {
      errors["lineFilterRegex"] = check.reason;
      return null;
    }
    prefix = { regex: rx };
  } else if (SOURCE_FILTER_PRESETS.includes(choice as SourceFilterPreset)) prefix = { preset: choice as SourceFilterPreset };
  else {
    errors["lineFilter"] = "ערך לא מוכר.";
    return null;
  }
  const exclude = used("lineFilterExclude") && (values["lineFilterExclude"] === true || values["lineFilterExclude"] === "true");
  const stripSpec = get("lineFilterStrip");
  const strip = used("lineFilterStrip") ? values["lineFilterStrip"] === true || values["lineFilterStrip"] === "true" : undefined;
  return { prefix, ...(exclude && { mode: "exclude" as const }), ...(strip !== undefined && stripSpec?.kind === "boolean" && strip !== stripSpec.default && { strip }) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Options of one engine as they were STORED (a job record read back from IndexedDB, which anyone can edit) →
 * only what the form could have produced: a known key with a value of the right type, numbers clamped to
 * their range, select values from the choices, regular expressions through the same guard as
 * `toEngineOptions`. Anything else is dropped, never passed on to the worker.
 */
export function sanitizeStoredOptions(engine: EngineId, stored: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const specs = ENGINE_OPTION_SPECS[engine];
  if (!specs || !isRecord(stored)) return out;
  for (const spec of specs) {
    const raw = stored[spec.key];
    if (raw === undefined) continue;
    switch (spec.kind) {
      case "boolean":
        if (typeof raw === "boolean") out[spec.key] = raw;
        break;
      case "number":
        if (spec.key.startsWith("t.")) break; // thresholds are stored together, below
        if (typeof raw === "number" && Number.isFinite(raw)) out[spec.key] = Math.round(Math.min(spec.max, Math.max(spec.min, raw)));
        break;
      case "select":
        if (spec.key === "targetStartsWithDh" ? typeof raw === "boolean" : typeof raw === "string" && spec.choices.some(([c]) => c === raw)) out[spec.key] = raw;
        break;
      case "regex":
        if (typeof raw === "string" && (spec.template ? compilePattern(raw) : checkCustomPattern(raw)).ok) out[spec.key] = raw;
        break;
      case "marker":
        if (raw === "sup" || raw === "sub" || raw === "parentheses") out[spec.key] = raw;
        else if (isRecord(raw) && typeof raw["tag"] === "string" && /^[a-zA-Z][\w-]*$/.test(raw["tag"])) out[spec.key] = { tag: raw["tag"] };
        else if (isRecord(raw) && typeof raw["regex"] === "string" && checkCustomPattern(raw["regex"]).ok) out[spec.key] = { regex: raw["regex"] };
        break;
    }
  }
  if (specs.some((x) => x.key === "lineFilter")) {
    const f = parseSourceFilter(stored["sourceFilter"]);
    if (f && compileSourceFilter(f).ok) out["sourceFilter"] = f;
  }
  const t = stored["thresholds"];
  if (isRecord(t)) {
    const { certain, high, possible, ambiguityMargin } = t;
    const ok = [certain, high, possible, ambiguityMargin].every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1);
    if (ok && (possible as number) <= (high as number) && (high as number) <= (certain as number)) out["thresholds"] = { certain, high, possible, ambiguityMargin };
  }
  return out;
}
