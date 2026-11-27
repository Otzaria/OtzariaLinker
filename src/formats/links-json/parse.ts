import { inlineLinkerVersionNote, isDocumentedInlineLinker, parseConnectionType } from "../../core/links/connection-type";
import { detectLayout, mayBeSpelledOtherwise, type JsonLayout } from "./layout";
import { CONNECTION_TYPE_KEY, DOUBLE_N_KEY, KNOWN_KEYS, type LinksRecord, type RecordOrigin } from "./record";

/*
 * Parses a `_links.json` file. Unlike the generator — which DROPS THE WHOLE FILE when one record
 * fails to decode (Generator.kt:2807-2836) — this keeps every good record and reports each problem
 * with its record index, and flags that the generator would reject the file as it stands.
 */
export type IssueLevel = "error" | "warning";

export interface ParseIssue {
  /** record index (0-based), or -1 for the file as a whole */
  index: number;
  level: IssueLevel;
  code: string;
  message: string;
  /** the technical cause (a parser's own words), for a details expander — never the main text (audit F14) */
  detail?: string;
}

export interface ParseResult {
  records: LinksRecord[];
  issues: ParseIssue[];
  /** true when the generator would discard the entire file (any record that cannot be decoded) */
  generatorRejectsFile: boolean;
  /** true when the weekly pipeline's byte gate would refuse it (BOM, CR, extra trailing newlines, duplicate keys) */
  pipelineRejectsBytes: boolean;
}

export function parseLinksJson(text: string): ParseResult {
  const steps = parseLinksJsonSteps(text);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Records decoded between two yields of parseLinksJsonSteps, and characters of the duplicate-key scan. */
const RECORDS_PER_STEP = 2_000;
const SCAN_CHARS_PER_STEP = 1_000_000;

/**
 * The same parse as parseLinksJson, as a generator that yields between slices of the work (#42 C5: a file of 235,000 records
 * was parsed in one block of 1.5–2.6 s on the page). A caller that runs it in slices gives the thread back between them; the
 * only step that cannot be cut is JSON.parse itself. The result is the object parseLinksJson returns.
 */
export function* parseLinksJsonSteps(text: string): Generator<void, ParseResult, void> {
  const issues: ParseIssue[] = [];
  const file = (level: IssueLevel, code: string, message: string, detail?: string) => issues.push({ index: -1, level, code, message, ...(detail && { detail }) });
  let pipelineRejectsBytes = false;

  if (text.startsWith("﻿")) {
    file("warning", "file/bom", "בתחילת הקובץ יש תו נסתר שעורכי טקסט מוסיפים. אוצריא מתעלמת ממנו, אבל הסנכרון השבועי של הספרייה דוחה קובץ כזה; שמירה מחדש בכלי מתקנת את זה.", "BOM");
    pipelineRejectsBytes = true;
  }
  if (text.includes("\r")) {
    file("warning", "file/cr", "סופי השורות בקובץ הם בסגנון Windows. הסנכרון השבועי של הספרייה דוחה קובץ כזה; שמירה מחדש בכלי מתקנת את זה.", "CR");
    pipelineRejectsBytes = true;
  }
  if (/\n\s*\n\s*$/.test(text)) {
    file("warning", "file/trailing-newlines", "בסוף הקובץ יש יותר משורה ריקה אחת. הסנכרון השבועי של הספרייה דוחה קובץ כזה.");
    pipelineRejectsBytes = true;
  }
  const dupScan = new DuplicateKeyScan(text);
  while (!dupScan.step(SCAN_CHARS_PER_STEP)) yield;
  const dup = dupScan.found;
  if (dup !== null) {
    file("warning", "file/duplicate-key", `באותה רשומה מופיע פעמיים המפתח "${dup}". רק המופע האחרון נקרא, והסנכרון השבועי דוחה קובץ כזה.`);
    pipelineRejectsBytes = true;
  }

  yield; // the scan's last slice and JSON.parse are not one block
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    // plain words first; the parser's message ("Unexpected end of JSON input") is only the detail
    file("error", "file/not-json", "הקובץ פגום: הוא נקטע או שאינו קובץ קישורים, ולכן אוצריא לא תקרא ממנו אף קישור.", `JSON.parse: ${(e as Error).message}`);
    return { records: [], issues, generatorRejectsFile: true, pipelineRejectsBytes: true };
  }
  if (!Array.isArray(data)) {
    const looksLikeDictaMap = data !== null && typeof data === "object";
    file("error", "file/not-array", looksLikeDictaMap
      ? "זה לא קובץ קישורים של אוצריא (כנראה מפה של Dicta), ולכן אוצריא מדלגת על כולו."
      : "זה לא קובץ קישורים: אין בו רשימת קישורים, ולכן אוצריא תדלג על כולו.",
      looksLikeDictaMap ? "JSON object, not an array of records" : "JSON value is not an array of records");
    return { records: [], issues, generatorRejectsFile: true, pipelineRejectsBytes: true };
  }

  const records: LinksRecord[] = [];
  let generatorRejectsFile = false;
  const origin = fileOrigins(text, data.length);
  for (let index = 0; index < data.length; index++) {
    if (index && index % RECORDS_PER_STEP === 0) yield;
    const record = decodeRecord(data[index], (level, code, message) => issues.push({ index, level, code, message }));
    if (!record) {
      generatorRejectsFile = true;
      continue;
    }
    record.origin = origin(index);
    records.push(record);
  }
  if (generatorRejectsFile)
    file("error", "file/generator-rejects", "לפחות רשומה אחת לא ניתנת לפענוח, ולכן אוצריא תדלג על הקובץ כולו. תקנו את הרשומות המסומנות לפני השימוש.");
  return { records, issues, generatorRejectsFile, pipelineRejectsBytes };
}

/**
 * One record from its own JSON text (an imported record's `fileText`), or null when the text is not
 * exactly one decodable record: a single object, LF only, no BOM, no duplicate key.
 */
export function recordFromText(text: string): LinksRecord | null {
  if (!text.startsWith("{") || !text.endsWith("}") || text.includes("\r") || text.includes("\uFEFF") || findDuplicateKey(text) !== null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  let ok = true;
  const record = decodeRecord(raw, (level) => void (level === "error" && (ok = false)));
  return ok ? record : null;
}

type Report = (level: IssueLevel, code: string, message: string) => void;

/** One record of the array, as the generator decodes it; null when the generator could not. */
function decodeRecord(raw: unknown, rec: Report): LinksRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    rec("error", "record/not-object", "הרשומה אינה אובייקט.");
    return null;
  }
  const r = raw as Record<string, unknown>;
  let decodable = true;
  const num = (key: string, required: boolean): number | undefined => {
    const v = r[key];
    if (v === undefined || v === null) {
      if (required) { rec("error", "record/missing-field", `חסר השדה ${key}.`); decodable = false; }
      return undefined;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      rec("error", "record/not-number", `השדה ${key} אינו מספר (${JSON.stringify(v)}).`);
      decodable = false;
      return undefined;
    }
    if (!Number.isInteger(v)) rec("warning", "record/not-integer", `${key} = ${v} אינו מספר שלם. אוצריא קוטעת אותו, והסנכרון השבועי דוחה אותו.`);
    return v;
  };
  const str = (key: string, required: boolean): string | undefined => {
    const v = r[key];
    if (v === undefined || v === null) {
      if (required) { rec("error", "record/missing-field", `חסר השדה ${key}.`); decodable = false; }
      return undefined;
    }
    if (typeof v !== "string") { rec("error", "record/not-string", `השדה ${key} אינו מחרוזת.`); decodable = false; return undefined; }
    return v;
  };

  const li1 = num("line_index_1", true);
  const li2 = num("line_index_2", true);
  const heRef2 = str("heRef_2", true);
  const path2 = str("path_2", true);
  const li1e = num("line_index_1_end", false);
  const li2e = num("line_index_2_end", false);
  const start = num("start", false);
  const end = num("end", false);
  const ref1 = str("ref_1", false);
  const ref2 = str("ref_2", false);
  const typeRaw = r[CONNECTION_TYPE_KEY];
  if (typeRaw !== undefined && typeRaw !== null && typeof typeRaw !== "string") {
    rec("error", "record/not-string", `השדה "${CONNECTION_TYPE_KEY}" אינו מחרוזת.`);
    decodable = false;
  }
  if (!decodable) return null;

  for (const [key, v] of [["line_index_1", li1], ["line_index_2", li2]] as const)
    if (v! < 1) rec("warning", "record/index-below-1", `${key} = ${v}: שורות בקובץ מתחילות ב־1. אוצריא ממפה ערך כזה לשורה הראשונה, והסנכרון השבועי דוחה אותו.`);
  if (DOUBLE_N_KEY in r && !(CONNECTION_TYPE_KEY in r))
    rec("warning", "record/double-n-type", `שם השדה כתוב "${DOUBLE_N_KEY}" (שני n). אוצריא מתעלמת ממנו והקישור יישמר כ"אחר". השם הנכון הוא "${CONNECTION_TYPE_KEY}".`);
  const connectionType = typeof typeRaw === "string" ? typeRaw : "";
  const t = parseConnectionType(connectionType);
  // the tool's own private type (#42 C22): not "unknown", but a type of Otzaria's personal import that depends on the version
  if (!t.known && isDocumentedInlineLinker(connectionType))
    rec("warning", "record/inline-linker", `הסוג "${connectionType}" הוא "ציטוט בטקסט", סוג פרטי של הייבוא האישי באוצריא. מחולל הספרייה שומר אותו כ"אחר". ${inlineLinkerVersionNote()}`);
  else if (!t.known) rec("warning", "record/unknown-type", `סוג הקשר "${connectionType}" אינו מוכר לאוצריא, והקישור יישמר כ"אחר".`);
  if (t.type === "LINKER") rec("warning", "record/linker-skipped", 'רשומות מסוג "linker" אינן מיובאות לאוצריא כלל.');

  // defineProperty: a key named "__proto__" is kept as data, not taken as the object's prototype
  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(r)) if (!KNOWN_KEYS.has(k)) Object.defineProperty(extras, k, { value: r[k], enumerable: true, writable: true, configurable: true });

  return {
    line_index_1: li1!, line_index_2: li2!, heRef_2: heRef2!, path_2: path2!, connectionType,
    ...(typeRaw === null && { typeNull: true }),
    ...(li1e !== undefined && { line_index_1_end: li1e }),
    ...(li2e !== undefined && { line_index_2_end: li2e }),
    ...(start !== undefined && { start }),
    ...(end !== undefined && { end }),
    ...(ref1 !== undefined && { ref_1: ref1 }),
    ...(ref2 !== undefined && { ref_2: ref2 }),
    extras,
    keyOrder: Object.keys(r),
  };
}

/** The origins of a file's records, sharing one lazily computed split, layout and spelling check. */
function fileOrigins(text: string, count: number): (index: number) => RecordOrigin {
  const file = new FileText(text, count);
  return (index) => new Origin(file, index);
}

class FileText {
  private readonly body: string;
  private spans: [number, number][] | null | undefined;
  private shape: JsonLayout | undefined;
  private mayDiffer: boolean | undefined;

  constructor(
    private readonly text: string,
    private readonly count: number,
  ) {
    this.body = text.replace(/^\uFEFF/, "");
  }

  layout(): JsonLayout {
    return (this.shape ??= detectLayout(this.text));
  }

  spellingMayDiffer(): boolean {
    return (this.mayDiffer ??= mayBeSpelledOtherwise(this.body, this.layout()));
  }

  record(index: number): string | null {
    if (this.spans === undefined) this.spans = elementSpans(this.body, this.count);
    const at = this.spans?.[index];
    return at ? this.body.slice(at[0], at[1]) : null;
  }
}

class Origin implements RecordOrigin {
  constructor(
    private readonly file: FileText,
    private readonly index: number,
  ) {}

  text(): string | null {
    return this.file.record(this.index);
  }

  layout(): JsonLayout {
    return this.file.layout();
  }

  spellingMayDiffer(): boolean {
    return this.file.spellingMayDiffer();
  }
}


/**
 * [start, end) of each element of the top-level array in `text` (already valid JSON — JSON.parse
 * accepted it), or null if the scan disagrees with the parsed length.
 */
function elementSpans(text: string, count: number): [number, number][] | null {
  const out: [number, number][] = [];
  let i = text.indexOf("[") + 1;
  if (i === 0) return null;
  const ws = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t";
  for (;;) {
    while (i < text.length && ws(text[i]!)) i++;
    if (text[i] === "]") break;
    const start = i;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === '"') {
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      } else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (depth === 0) break; // the array's own "]" after a scalar element
        if (--depth === 0) {
          i++;
          break;
        }
      } else if (c === "," && depth === 0) break;
    }
    let end = i;
    while (end > start && ws(text[end - 1]!)) end--;
    out.push([start, end]);
    while (i < text.length && ws(text[i]!)) i++;
    if (text[i] === ",") i++;
    else break;
  }
  return out.length === count ? out : null;
}

/**
 * First key that appears twice in the same JSON object, or null. JSON.parse silently keeps the last
 * one; the library pipeline refuses such files (STRICT_DUPLICATE_DETECTION). Keys are compared as
 * spelled (escapes included).
 */
export function findDuplicateKey(text: string): string | null {
  const scan = new DuplicateKeyScan(text);
  while (!scan.step(Number.MAX_SAFE_INTEGER));
  return scan.found;
}

/**
 * findDuplicateKey, resumable: step() scans about `budget` more characters. A string is skipped with indexOf (a quote after an
 * odd run of backslashes is escaped) and copied only when it is a key: the scan used to build every string a character at a
 * time, the costliest part of parsing a big file (#42 C5).
 */
class DuplicateKeyScan {
  found: string | null = null;
  private i = 0;
  private expectKey = false;
  private readonly stack: (Set<string> | null)[] = [];

  constructor(private readonly text: string) {}

  /** true when the scan is over: a duplicate found, or the end of the text */
  step(budget: number): boolean {
    const { text, stack } = this;
    const n = text.length;
    let i = this.i;
    const stop = Math.min(n, i + budget);
    while (i < stop) {
      const c = text.charCodeAt(i);
      if (c === 34 /* " */) {
        let j = text.indexOf('"', i + 1);
        while (j > 0 && escapedAt(text, j)) j = text.indexOf('"', j + 1);
        if (j < 0) j = n;
        const top = stack[stack.length - 1];
        if (this.expectKey && top) {
          const key = text.slice(i + 1, j);
          if (top.has(key)) {
            this.i = n;
            this.found = JSON.parse(`"${key}"`) as string;
            return true;
          }
          top.add(key);
          this.expectKey = false;
        }
        i = j + 1;
        continue;
      }
      if (c === 123 /* { */) {
        stack.push(new Set());
        this.expectKey = true;
      } else if (c === 91 /* [ */) stack.push(null);
      else if (c === 125 /* } */ || c === 93 /* ] */) stack.pop();
      else if (c === 44 /* , */) this.expectKey = stack[stack.length - 1] instanceof Set;
      i++;
    }
    this.i = i;
    return i >= n;
  }
}

/** The quote at `at` follows an odd run of backslashes: it is part of the string. */
function escapedAt(text: string, at: number): boolean {
  let k = at - 1;
  while (text.charCodeAt(k) === 92 /* \ */) k--;
  return (at - 1 - k) % 2 === 1;
}
