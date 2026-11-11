import { entriesToNodes, nodesToEntries, writtenStructures, type AltTocNode, type AltTocStructure } from "../../core/alt-toc/model";

/*
 * `alt_toc/<book title>_alt_toc.json` — read and write. The decoding rules are those of the
 * generator (SeforimLibrary@23f1f8f1 Generator.kt:2472 and the data classes at :2863-2878, with
 * `Json { ignoreUnknownKeys = true; coerceInputValues = true }` at :128), reimplemented:
 *   • a UTF-8 BOM is stripped (Utf8Bom.strip);
 *   • the top level must be an array of structures;
 *   • `key` (string) is required in every structure, `heTitle` (string) and `line` (number) in every
 *     node — one missing or mistyped value makes kotlinx fail, and the generator then skips the
 *     WHOLE file for that run;
 *   • `title`, `heTitle` of a structure may be absent or null; `nodes` / `children` default to [];
 *   • `line` is a Double truncated toward zero (`node.line.toInt()`); unknown keys are ignored.
 */
export const ALT_TOC_SUFFIX = "_alt_toc.json";

export const altTocFileName = (title: string): string => `${title}${ALT_TOC_SUFFIX}`;

/** The book title an alt_toc file name carries ("x/בראשית_alt_toc.json" → "בראשית"), or null. */
export function titleFromAltTocFileName(path: string): string | null {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return name.endsWith(ALT_TOC_SUFFIX) && name.length > ALT_TOC_SUFFIX.length ? name.slice(0, -ALT_TOC_SUFFIX.length) : null;
}

export interface AltTocParseIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface AltTocParseResult {
  structures: AltTocStructure[];
  issues: AltTocParseIssue[];
  /** the generator would not decode the file at all (it skips it and keeps the book's old structures) */
  generatorRejectsFile: boolean;
}

export function parseAltTocJson(text: string): AltTocParseResult {
  const issues: AltTocParseIssue[] = [];
  let reject = false;
  const fail = (code: string, message: string) => ((reject = true), issues.push({ level: "error", code, message }));
  const warn = (code: string, message: string) => issues.push({ level: "warning", code, message });

  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    fail("alt-toc/not-json", `הקובץ אינו JSON תקין (${(err as Error).message}).`);
    return { structures: [], issues, generatorRejectsFile: true };
  }
  if (!Array.isArray(raw)) {
    fail("alt-toc/not-a-list", "קובץ alt_toc חייב להיות רשימה ([…]) של מבנים.");
    return { structures: [], issues, generatorRejectsFile: true };
  }

  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  const optString = (o: Record<string, unknown>, k: string, where: string): string | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v === "string") return v;
    fail("alt-toc/bad-field", `${where}: השדה ${k} חייב להיות טקסט.`);
    return undefined;
  };
  const list = (o: Record<string, unknown>, k: string, where: string): unknown[] => {
    const v = o[k];
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v;
    fail("alt-toc/bad-field", `${where}: השדה ${k} חייב להיות רשימה.`);
    return [];
  };

  const node = (x: unknown, where: string): AltTocNode | null => {
    if (!isObj(x)) {
      fail("alt-toc/bad-node", `${where}: צומת חייב להיות אובייקט.`);
      return null;
    }
    const heTitle = x.heTitle;
    const line = x.line;
    if (typeof heTitle !== "string") fail("alt-toc/node-title-missing", `${where}: חסר heTitle (טקסט), שהוא חובה.`);
    if (typeof line !== "number" || !Number.isFinite(line)) fail("alt-toc/node-line-missing", `${where}: חסר line (מספר), שהוא חובה.`);
    const lineNo = typeof line === "number" && Number.isFinite(line) ? Math.trunc(line) : 0;
    if (typeof line === "number" && Number.isFinite(line) && lineNo !== line) warn("alt-toc/line-fraction", `${where}: השורה ${line} אינה מספר שלם. אוצריא תשתמש ב־${lineNo}.`);
    const title = typeof heTitle === "string" ? heTitle : "";
    const kids = list(x, "children", where)
      .map((c, i) => node(c, `${where} ← ${i + 1}`))
      .filter((c): c is AltTocNode => !!c);
    return { heTitle: title, line: lineNo, ...(kids.length && { children: kids }) };
  };

  const structures: AltTocStructure[] = [];
  raw.forEach((s, i) => {
    const where = `מבנה ${i + 1}`;
    if (!isObj(s)) return void fail("alt-toc/bad-structure", `${where}: מבנה חייב להיות אובייקט.`);
    if (typeof s.key !== "string") fail("alt-toc/key-missing", `${where}: חסר key (טקסט), שהוא חובה.`);
    const title = optString(s, "title", where);
    const heTitle = optString(s, "heTitle", where);
    const nodes = list(s, "nodes", where)
      .map((n, j) => node(n, `${where}, צומת ${j + 1}`))
      .filter((n): n is AltTocNode => !!n);
    structures.push({
      key: typeof s.key === "string" ? s.key : "",
      ...(title !== undefined && { title }),
      ...(heTitle !== undefined && { heTitle }),
      entries: nodesToEntries(nodes),
    });
  });
  return { structures, issues, generatorRejectsFile: reject };
}

/** The file object of a structure: key, title?, heTitle?, nodes — in that order. */
function structureToJson(s: AltTocStructure): Record<string, unknown> {
  return {
    key: s.key,
    ...(s.title && { title: s.title }),
    ...(s.heTitle && { heTitle: s.heTitle }),
    nodes: entriesToNodes(s.entries),
  };
}

/**
 * The file text. Deterministic: same structures, same bytes; no BOM, LF, two-space indent (the
 * links writer's rules, LINK_FORMATS §1.8). Empty structures are left out — the generator would
 * delete them anyway — so a book whose structures were all removed gets `[]`, which removes them
 * from the library.
 */
export function serializeAltToc(structures: readonly AltTocStructure[]): string {
  return JSON.stringify(writtenStructures(structures).map(structureToJson), null, 2);
}
