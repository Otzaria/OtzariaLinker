import { parseConnectionType } from "../../core/links/connection-type";
import { CONNECTION_TYPE_KEY, DOUBLE_N_KEY, KNOWN_KEYS, type LinksRecord } from "./record";

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
  const dup = findDuplicateKey(text);
  if (dup) {
    file("warning", "file/duplicate-key", `באותה רשומה מופיע פעמיים המפתח "${dup}". רק המופע האחרון נקרא, והסנכרון השבועי דוחה קובץ כזה.`);
    pipelineRejectsBytes = true;
  }

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
  data.forEach((raw, index) => {
    const rec = (level: IssueLevel, code: string, message: string) => issues.push({ index, level, code, message });
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      rec("error", "record/not-object", "הרשומה אינה אובייקט.");
      generatorRejectsFile = true;
      return;
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
    if (!decodable) { generatorRejectsFile = true; return; }

    for (const [key, v] of [["line_index_1", li1], ["line_index_2", li2]] as const)
      if (v! < 1) rec("warning", "record/index-below-1", `${key} = ${v}: שורות בקובץ מתחילות ב־1. אוצריא ממפה ערך כזה לשורה הראשונה, והסנכרון השבועי דוחה אותו.`);
    if (DOUBLE_N_KEY in r && !(CONNECTION_TYPE_KEY in r))
      rec("warning", "record/double-n-type", `שם השדה כתוב "${DOUBLE_N_KEY}" (שני n). אוצריא מתעלמת ממנו והקישור יישמר כ"אחר". השם הנכון הוא "${CONNECTION_TYPE_KEY}".`);
    const connectionType = typeof typeRaw === "string" ? typeRaw : "";
    const t = parseConnectionType(connectionType);
    if (!t.known) rec("warning", "record/unknown-type", `סוג הקשר "${connectionType}" אינו מוכר לאוצריא, והקישור יישמר כ"אחר".`);
    if (t.type === "LINKER") rec("warning", "record/linker-skipped", 'רשומות מסוג "linker" אינן מיובאות לאוצריא כלל.');

    // defineProperty: a key named "__proto__" is kept as data, not taken as the object's prototype
    const extras: Record<string, unknown> = {};
    for (const k of Object.keys(r)) if (!KNOWN_KEYS.has(k)) Object.defineProperty(extras, k, { value: r[k], enumerable: true, writable: true, configurable: true });

    records.push({
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
    });
  });
  if (generatorRejectsFile)
    file("error", "file/generator-rejects", "לפחות רשומה אחת לא ניתנת לפענוח, ולכן אוצריא תדלג על הקובץ כולו. תקנו את הרשומות המסומנות לפני השימוש.");
  return { records, issues, generatorRejectsFile, pipelineRejectsBytes };
}

/**
 * First key that appears twice in the same JSON object, or null. JSON.parse silently keeps the last
 * one; the library pipeline refuses such files (STRICT_DUPLICATE_DETECTION).
 */
export function findDuplicateKey(text: string): string | null {
  const stack: (Set<string> | null)[] = [];
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") { s += text.slice(j, j + 2); j += 2; } else s += text[j++];
      }
      const top = stack.at(-1);
      if (expectKey && top) {
        if (top.has(s)) return JSON.parse(`"${s}"`) as string;
        top.add(s);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === "{") { stack.push(new Set()); expectKey = true; }
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") expectKey = stack.at(-1) instanceof Set;
    i++;
  }
  return null;
}
