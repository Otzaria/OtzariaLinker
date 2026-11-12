/*
 * The structure-reference PRESETS of the pattern engine: data, not code. Each one is a pattern
 * template (pattern/template.ts — placeholders like {סימן} name what each number is), where its
 * numbers point, and the examples that document it. tests/unit/linking/pattern/presets.test.ts runs
 * every example through the engine: each `matches` example must give exactly the path written next
 * to it, each `rejects` example must give nothing.
 *
 * Sources of the grammar (docs/research/REUSE_MATRIX.md §10 has the full inventory):
 *   • the kind words, abbreviations and glued forms ("פ"ב", "ה"ג", "סק"א", "רפ"ג", "ס"ג") —
 *     otzaria-link-generator's seifKatan.ts/halachaAlgorithm.ts (Otzaria org, ported as patterns) and
 *     LinkerToOtzaria's chapter/daf grammar (Otzaria org, ported as patterns);
 *   • daf forms ("דף ב.", "ב:", "ב ע"א", "דף ב עמוד ב", "(ב:)") — the same, plus the IDEA of the
 *     auto-linker plugin and Otzariya_Link_Maker's daf rules (outside the org, no code taken);
 *   • "(א)" / "[א]" markers — Otzariya_Link_Maker's numbering rule and link-generator's
 *     HALACHA_NUMBERING_RE (idea; never "א'" alone, which is "ר' יוחנן", "ב' דברים").
 *
 * Every template must stay within MAX_PATTERN_LENGTH so a user can open it in advanced mode and edit it.
 */

export type PresetTarget = "tree" | "line" | "chapter-line";

export interface PatternPreset {
  readonly id: string;
  /** the name in the method's list */
  readonly name: string;
  /** one line: what it is for */
  readonly description: string;
  readonly template: string;
  readonly target: PresetTarget;
  /** read every match of a line (references), not only the first (v3) */
  readonly matches: "first" | "all";
  /** merge matches that follow each other ("סימן ה, סעיף ג" found as two) into one reference */
  readonly chain?: boolean;
  /** skip a reference right after the name of another Bavli tractate ("שבת דף כג" in a ברכות run) */
  readonly otherTractateGuard?: boolean;
  /** examples: text → the path it reads, levels joined with " › " (a range: "סעיף ג-ה") */
  readonly examples: readonly (readonly [text: string, path: string])[];
  /** texts that must give no reference */
  readonly rejects: readonly string[];
}

// a reference may carry one or two prefix letters ("בסימן", "ובס"ק", "לעיל סי'")
const P = "(?<![א-ת])[ובלמהדשכ]{0,2}";
const RANGE = "(?:\\s?[-–]\\s?{עד})?";
const PEREK = "(?:פרק\\s{1,2}|[רס]?פ[\"״])";

export const PATTERN_PRESETS: readonly PatternPreset[] = [
  {
    id: "general",
    name: "כל הפניה מבנית",
    description: "מילת סוג ומספר, ברמה אחת או כמה: סימן, סעיף, ס\"ק, פרק, פסוק, הלכה, משנה, דף, אות, הערה, מאמר, שער, כלל…",
    template: `${P}(?:(?:סימן|סעיף|פרק|פסוק|הלכה|משנה|דף|אות|הערה|מאמר|שער|כלל|שורש|מצו?וה|תיקון|דרוש|חלק|פרשה)\\s{1,2}|(?:סי|סעי?)['׳]\\s?|ס["״]ק\\s?){מספר}(?:\\s?{עמוד})?`,
    target: "tree",
    matches: "all",
    chain: true,
    examples: [
      ["עיין סימן ה סעיף ג", "סימן ה › סעיף ג"],
      ['כמ"ש בסי\' קכ"ג', "סימן קכג"],
      ['ועיין ס"ק ב', 'סעיף קטן ב'],
      ["בפרק ג הלכה ב", "פרק ג › הלכה ב"],
      ["דף ה.", "דף ה."],
      ["פרק שני", "פרק ב"],
    ],
    rejects: ["בסעיף זה", "סימן לדבר", "פרקים רבים"],
  },
  {
    id: "daf",
    name: "דף ועמוד",
    description: "דף ועמוד בתלמוד: \"דף ב.\", \"דף ב:\", \"דף ב ע\"א\", \"דף ב עמוד ב\", \"(ב:)\", \"ב ע\"א\"",
    template: `(?:(?<![א-ת])[ובלמ]?(?:דף|ד['׳])\\s?|(?<=[(\\[])(?=[א-ת"'׳״]{1,5}\\s?(?:[.:]|ע["״]))|(?<![א-ת])(?=[א-ת"'׳״]{1,5}\\sע["״][אב](?![א-ת]))){דף}(?:,?\\s?{עמוד})?`,
    target: "tree",
    matches: "all",
    otherTractateGuard: true,
    examples: [
      ["דף ב.", "דף ב."],
      ["בדף ב:", "דף ב:"],
      ['דף ב ע"א', "דף ב."],
      ["דף ל עמוד ב", "דף ל:"],
      ["(ב:)", "דף ב:"],
      ['ראה יג ע"ב', "דף יג:"],
      ["דף ה", "דף ה"],
      ['דף קכ"ג.', "דף קכג."],
    ],
    rejects: ["(ב)", "עד כאן:", "ב:", "שבת דף כג"],
  },
  {
    id: "masechet-daf",
    name: "מסכת ודף",
    description: "שם המסכת ודף: \"ברכות דף ב.\", \"מסכת שבת דף כא ע\"ב\", \"ב\"ק לג:\" — רק הפניות שמזכירות את מסכת היעד",
    template: `(?<![א-ת])(?:[ובלמ]?מסכת\\s)?{שם_ספר}\\s{1,2}(?:(?:דף\\s|ד['׳]\\s?){דף}(?:,?\\s?{עמוד})?|{דף}\\s?{עמוד})`,
    target: "tree",
    matches: "all",
    examples: [
      ["ברכות דף ב.", "ברכות › דף ב."],
      ['במסכת ברכות דף ט ע"ב', "ברכות › דף ט:"],
      ["ברכות ב.", "ברכות › דף ב."],
    ],
    rejects: ["ברכות הרבה", "ברכות שלש"],
  },
  {
    id: "perek-mishna",
    name: "פרק ומשנה",
    description: "משנה: \"פרק ב משנה ג\", \"פ\"ב מ\"ג\", \"רפ\"ג\", \"משנה ג\" (הפרק לפי הכותרות של שורת המקור)",
    template: `${P}(?:${PEREK}{פרק}(?:,?\\s{1,2}(?:משנה\\s{1,2}|מ["״]){משנה})?|משנה\\s{1,2}{משנה})${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [
      ["פרק ב משנה ג", "פרק ב › משנה ג"],
      ['פ"ב מ"ג', "פרק ב › משנה ג"],
      ['ברפ"ג', "פרק ג"],
      ["משנה ד", "משנה ד"],
      ["פרק ראשון משנה ב", "פרק א › משנה ב"],
      ["משנה ב-ד", "משנה ב-ד"],
    ],
    rejects: ["משנה ראשונה לא זזה", "פרק זה", "פרקי אבות"],
  },
  {
    id: "perek-halacha",
    name: "פרק והלכה",
    description: "רמב\"ם וירושלמי: \"פרק ג הלכה ב\", \"פ\"ג ה\"ב\", \"פ\"ג הל' ב\", \"הלכה ב\"",
    template: `${P}(?:${PEREK}{פרק}(?:,?\\s{1,2}(?:הלכה\\s{1,2}|הל['׳]\\s?|ה["״]){הלכה})?|הלכה\\s{1,2}{הלכה})${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [
      ["פרק ג הלכה ב", "פרק ג › הלכה ב"],
      ['פ"ג ה"ב', "פרק ג › הלכה ב"],
      ["פ\"ג הל' ב", "פרק ג › הלכה ב"],
      ['הלכה י"א', "הלכה יא"],
    ],
    rejects: ["הלכה למשה מסיני", "הלכה כמותו"],
  },
  {
    id: "perek-pasuk",
    name: "פרק ופסוק",
    description: "תנ\"ך: \"פרק ג פסוק ב\", \"פ\"ג פס' ב\", \"(ג, ב)\", \"פסוק ב\"",
    template: `${P}(?:${PEREK}{פרק}(?:,?\\s{1,2}(?:פסוק\\s{1,2}|פס['׳]\\s?){פסוק})?|פסוק\\s{1,2}{פסוק}|(?<=\\()(?=[^,()]{1,6},\\s?[^,()]{1,6}\\)){פרק},\\s?{פסוק})${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [
      ["פרק ג פסוק ב", "פרק ג › פסוק ב"],
      ["פ\"ג פס' ב", "פרק ג › פסוק ב"],
      ["(ג, ב)", "פרק ג › פסוק ב"],
      ["פסוק טו", "פסוק טו"],
    ],
    rejects: ["פסוק זה", "(שם, שם)"],
  },
  {
    id: "parsha",
    name: "פרשה",
    description: "\"פרשה ג\" (מדרש רבה), \"פרשת נח\" (לפי שם הכותרת ביעד)",
    template: `(?<![א-ת])[ובל]?(?:פרשה\\s{1,2}{פרשה}|(?=פרשת\\s[א-ת]){שם})`,
    target: "tree",
    matches: "all",
    examples: [
      ["פרשה ג", "פרשה ג"],
      ["בפרשה י\"ב", "פרשה יב"],
    ],
    rejects: ["פרשה זו"],
  },
  {
    id: "siman",
    name: "סימן",
    description: "\"סימן ה\", \"סי' קכ\"ג\", \"סימנים ה-ז\"",
    template: `${P}(?:(?:סימן|סימנים)\\s{1,2}|סי['׳]\\s?){סימן}${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [
      ["סימן ה", "סימן ה"],
      ['בסי\' קכ"ג', "סימן קכג"],
      ["סימנים ה-ז", "סימן ה-ז"],
      ["סימן 12", "סימן יב"],
    ],
    rejects: ["סימן לדבר", "סימנים"],
  },
  {
    id: "siman-seif",
    name: "סימן וסעיף",
    description: "\"סימן ה סעיף ג\", \"סי' ה ס\"ג\", \"סעיף ג\" (הסימן לפי הכותרות של שורת המקור), \"סעיף ג-ה\"",
    template: `${P}(?=ס)(?:(?:סימן|סי['׳])\\s?{סימן})?(?:,?\\s{1,2})?(?:(?:סעיף|סעי?['׳])\\s?{סעיף}|ס["״](?!ק){סעיף})?${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [
      ["סימן ה סעיף ג", "סימן ה › סעיף ג"],
      ['סי\' קל"א ס"ג', "סימן קלא › סעיף ג"],
      ["סעיף ג", "סעיף ג"],
      ["סעיף ג-ה", "סעיף ג-ה"],
      ["סימן ה", "סימן ה"],
    ],
    rejects: ["סעיף זה", "סיפור", 'ס"ק ב'],
  },
  {
    id: "siman-seif-sk",
    name: "סימן, סעיף וס\"ק",
    description: "\"סימן ה סעיף ג ס\"ק ב\", \"סי' ה ס\"ק ב\", \"סק\"א\", \"ס\"ק א\", \"סעיף קטן א\", \"ס\"ק א-ג\", \"ס\"ק א ב\"",
    template: `${P}(?=ס)(?:(?:סימן|סי['׳])\\s?{סימן},?\\s{0,2})?(?:(?:סעיף|סע['׳])\\s?{סעיף},?\\s{0,2})?(?:(?:ס["״]ק|סעיף\\sקטן)\\s?{ס"ק}|סק["״]{ס"ק}|סק(?=[א-ת]{1,2}["״]){ס"ק})(?:\\s?[-–]\\s?{עד}|\\s{עד})?`,
    target: "tree",
    matches: "all",
    examples: [
      ['סימן ה סעיף ג ס"ק ב', "סימן ה › סעיף ג › סעיף קטן ב"],
      ['סי\' ה ס"ק ב', "סימן ה › סעיף קטן ב"],
      ['סק"א', 'סעיף קטן א'],
      ['סקי"ב', 'סעיף קטן יב'],
      ["סעיף קטן א", 'סעיף קטן א'],
      ['ס"ק א-ג', 'סעיף קטן א-ג'],
      ['ס"ק א ב', 'סעיף קטן א-ב'],
      ['ס"ק ג ומיד', 'סעיף קטן ג'],
    ],
    rejects: ["סקל", "סעיף ג", 'סעיף קטן זה'],
  },
  {
    id: "os",
    name: "אות",
    description: "\"אות ה\", \"באות קכ\"ג\", \"אותיות ה-ז\"",
    template: `${P}(?:אות|אותיות)\\s{1,2}{אות}${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [
      ["אות ה", "אות ה"],
      ['באות קכ"ג', "אות קכג"],
    ],
    rejects: ["אות זו", "אותיות התורה"],
  },
  {
    id: "note",
    name: "הערה",
    description: "\"הערה ה\", \"הערות ה-ז\", \"הע' 5\"",
    template: `${P}(?:הערה|הערות|הע['׳])\\s{0,2}{הערה}${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [
      ["הערה ה", "הערה ה"],
      ["הערות ה-ז", "הערה ה-ז"],
      ["הע' 5", "הערה ה"],
    ],
    rejects: ["הערה חשובה"],
  },
  {
    id: "maamar",
    name: "מאמר ופרק",
    description: "\"מאמר ג\", \"מאמר ג פרק ב\"",
    template: `${P}מאמר\\s{1,2}{מאמר}(?:,?\\s{1,2}${PEREK}{פרק})?${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [
      ["מאמר ג", "מאמר ג"],
      ["מאמר ג פרק ב", "מאמר ג › פרק ב"],
    ],
    rejects: ["מאמר חז\"ל"],
  },
  {
    id: "shaar-perek",
    name: "שער ופרק",
    description: "\"שער ג פרק ב\", \"ש\"ג פ\"ב\", \"שער הבטחון פרק ג\" (שם השער לפי הכותרת ביעד)",
    template: `${P}(?:(?=שער\\sה[א-ת]{2}){שם}|שער\\s{1,2}{שער}|ש["״]{שער})(?:,?\\s{1,2}${PEREK}{פרק})?${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [
      ["שער ג פרק ב", "שער ג › פרק ב"],
      ['ש"ג פ"ב', "שער ג › פרק ב"],
    ],
    rejects: ["שערי תשובה", "שער ז\"ה"],
  },
  {
    id: "klal-seif",
    name: "כלל וסעיף",
    description: "\"כלל ג סעיף ב\", \"כלל ג ס\"ב\" (חיי אדם, נשמת אדם)",
    template: `${P}כלל\\s{1,2}{כלל}(?:,?\\s{1,2}(?:(?:סעיף|סעי?['׳])\\s?|ס["״](?!ק)){סעיף})?${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [
      ["כלל ג סעיף ב", "כלל ג › סעיף ב"],
      ['כלל ג ס"ב', "כלל ג › סעיף ב"],
      ["כלל ה", "כלל ה"],
    ],
    rejects: ["כלל גדול", "בכלל"],
  },
  {
    id: "shoresh",
    name: "שורש",
    description: "\"שורש ג\", \"שרש ד\"",
    template: `${P}(?:שורש|שרש)\\s{1,2}{שורש}${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [["שורש ג", "שורש ג"], ["בשרש ד", "שורש ד"]],
    rejects: ["שורש הדבר"],
  },
  {
    id: "mitzva",
    name: "מצווה",
    description: "\"מצוה ג\", \"מצווה קכ\"ג\"",
    template: `${P}(?:מצוה|מצווה)\\s{1,2}{מצוה}${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [["מצוה ג", "מצוה ג"], ['במצווה קכ"ג', "מצוה קכג"]],
    rejects: ["מצוה רבה", "מצות עשה"],
  },
  {
    id: "tikun",
    name: "תיקון",
    description: "\"תיקון ע\", \"תקון כ\"א\" (תיקוני זהר)",
    template: `${P}(?:תיקון|תקון)\\s{1,2}{תיקון}${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [["תיקון ע", "תיקון ע"], ['בתקון כ"א', "תיקון כא"]],
    rejects: ["תיקון חצות"],
  },
  {
    id: "drush",
    name: "דרוש",
    description: "\"דרוש ג\", \"דרוש י\"א\"",
    template: `${P}דרוש\\s{1,2}{דרוש}${RANGE}`,
    target: "tree",
    matches: "all",
    examples: [["דרוש ג", "דרוש ג"], ['בדרוש י"א', "דרוש יא"]],
    rejects: ["דרוש וחקירה"],
  },
  {
    id: "chelek",
    name: "חלק או ספר, וסימן או פרק",
    description: "\"חלק ב סימן ה\", \"ח\"ב סי' ה\", \"ספר ב פרק ג\", \"חלק ג\"",
    template: `${P}(?:חלק\\s{1,2}{חלק}|ח["״](?!ו(?![א-ת])){חלק}|ספר\\s{1,2}{ספר})(?:,?\\s{1,2}(?:(?:סימן|סי['׳])\\s?{סימן}|${PEREK}{פרק}))?`,
    target: "tree",
    matches: "all",
    examples: [
      ["חלק ב סימן ה", "חלק ב › סימן ה"],
      ['ח"ב סי\' ה', "חלק ב › סימן ה"],
      ["ספר ב פרק ג", "ספר ב › פרק ג"],
      ["חלק ג", "חלק ג"],
    ],
    rejects: ['ח"ו', "חלק כחלק"],
  },
  {
    id: "marker",
    name: "מספר בסוגריים",
    description: "\"(א)\", \"[יב]\", \"(3)\" — מספר בלי מילת סוג; המקום לפי הכותרות של שורת המקור",
    template: "(?<![א-ת])[(\\[]{מספר}[)\\]]",
    target: "tree",
    matches: "all",
    examples: [
      ["(א)", "א"],
      ["[יב]", "יב"],
      ["(3)", "ג"],
    ],
    rejects: ["(שם)", "(זה)"],
  },
  {
    id: "v3",
    name: "גרסה 3: מספר שורה",
    description: "התבנית של גרסה 3: המספר שאחרי \"דף\", \"עמוד\" או \"סימן\" הוא מספר שורה ביעד",
    template: "(?:דף|עמוד|סימן)\\s{1,3}([א-ת׳״'\"]{1,6}|\\d{1,4})",
    target: "line",
    matches: "first",
    examples: [],
    rejects: [],
  },
];

export const DEFAULT_PRESET = "general";
export const CUSTOM_PRESET = "custom";

export function presetById(id: string | undefined): PatternPreset | undefined {
  return PATTERN_PRESETS.find((p) => p.id === (id || DEFAULT_PRESET));
}

/** Bavli tractates (names and common abbreviations), for the "another tractate" guard. Facts. */
export const BAVLI_TRACTATES: readonly string[] = [
  "ברכות", "שבת", "עירובין", "ערובין", "פסחים", "שקלים", "יומא", "סוכה", "ביצה", "ראש השנה", "ר\"ה", "תענית", "מגילה",
  "מועד קטן", "מו\"ק", "חגיגה", "יבמות", "כתובות", "נדרים", "נזיר", "סוטה", "גיטין", "קידושין", "קדושין",
  "בבא קמא", "ב\"ק", "בבא מציעא", "ב\"מ", "בבא בתרא", "ב\"ב", "סנהדרין", "מכות", "שבועות", "עבודה זרה", "ע\"ז",
  "הוריות", "זבחים", "מנחות", "חולין", "בכורות", "ערכין", "תמורה", "כריתות", "מעילה", "תמיד", "נדה", "נידה",
];
