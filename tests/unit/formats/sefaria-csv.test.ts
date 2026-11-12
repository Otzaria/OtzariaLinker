import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BookHeading } from "../../../src/core/books";
import type { BookRef, Link } from "../../../src/core/links/model";
import { headingLevel, stripTags } from "../../../src/core/text/html";
import { citationAt, csvField, planSefariaCsv, SEFARIA_CSV_HEADER, sefariaCsv } from "../../../src/formats/sefaria-csv/write";

/*
 * The CSV must be byte-identical to what version 3 wrote. Besides the explicit checks, the v3
 * functions themselves (`ExportBuilder.buildCsv`, `computeHeRef`, `activeHeadings`) are lifted out of
 * legacy/OtzariaLinker-v3.html — this project's own previous release — and run on the same data.
 */
// line endings normalised: a Windows checkout may have written the file with CRLF
const LEGACY = readFileSync("legacy/OtzariaLinker-v3.html", "utf8").replace(/\r\n/g, "\n");
function legacyMethod(signature: string): string {
  const at = LEGACY.indexOf(signature);
  if (at < 0) throw new Error(`not found in v3: ${signature}`);
  return LEGACY.slice(at, LEGACY.indexOf("\n    },\n", at) + 6);
}
function legacyFunction(signature: string): string {
  const at = LEGACY.indexOf(signature);
  if (at < 0) throw new Error(`not found in v3: ${signature}`);
  return LEGACY.slice(at, LEGACY.indexOf("\n  }\n", at) + 4);
}

type V3Book = { title: string; lines: string[] };
type V3Link = { status: string; sourceBook: V3Book; targetBook: V3Book; sourceLineIndex: number; targetLineIndex: number; heRef?: string; connectionType: string };
const v3 = new Function(
  "CONNECTION_TYPE_KEY",
  "stripTags",
  `const getLines = (b) => b.lines;
   const headingLevel = (c) => { const m = String(c || "").match(/<h([1-6])\\b/i); return m ? parseInt(m[1], 10) : null; };
   const isHeading = (c) => headingLevel(c) != null;
   const hasText = () => true;
   const lineContent = (b, i) => b.lines[i];
   ${legacyFunction("function activeHeadings(book, lineIndex){")}
   ${legacyFunction("function computeHeRef(book, lineIndex){")}
   return { ${legacyMethod("buildCsv(links, opts = {}){")} };`,
)("Conection Type", stripTags) as { buildCsv(links: V3Link[], opts?: { onlyNew?: boolean }): Map<string, string> };

const headingsOf = (lines: string[]): BookHeading[] =>
  lines.flatMap((l, i) => {
    const level = headingLevel(l);
    return level === null ? [] : [{ line: i, level, text: stripTags(l) }];
  });

describe("Sefaria-layout CSV (version 3's format)", () => {
  it("header, quoting, line breaks, no BOM, no final newline", () => {
    expect(SEFARIA_CSV_HEADER).toBe("Citation 1,Citation 2,Conection Type");
    expect(csvField("a")).toBe("a");
    expect(csvField('a "b"')).toBe('"a ""b"""');
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField("a\rb")).toBe("a\rb"); // v3 quoted only " , \n
    const text = sefariaCsv([{ citation1: "א, ב", citation2: 'רש"י', type: "commentary" }]);
    expect(text).toBe('Citation 1,Citation 2,Conection Type\n"א, ב","רש""י",commentary');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.endsWith("\n")).toBe(false);
  });

  it("citation = heading trail up to the line (deeper levels reset), else the title", () => {
    const hs = headingsOf(["<h1>אורח חיים</h1>", "<h2>סימן א</h2>", "סעיף א", "<h2>סימן ב</h2>", "<h3>סעיף א</h3>", "<h2>סימן ג</h2>", "טקסט"]);
    expect(citationAt(hs, 2, "ספר")).toBe("אורח חיים, סימן א");
    expect(citationAt(hs, 4, "ספר")).toBe("אורח חיים, סימן ב, סעיף א");
    expect(citationAt(hs, 6, "ספר")).toBe("אורח חיים, סימן ג");
    expect(citationAt([], 3, "ספר")).toBe("ספר");
  });

  it("is byte-identical to version 3's buildCsv on the same links", () => {
    const comm: V3Book = { title: "פירוש, על השולחן", lines: ["<h1>אורח חיים</h1>", "<h2>סימן א</h2>", "פירוש ראשון", "<h2>סימן ב \"מיוחד\"</h2>", "פירוש שני", "פירוש שלישי"] };
    const base: V3Book = { title: "שולחן ערוך", lines: ["<h1>אורח חיים</h1>", "<h2>סימן א</h2>", "סעיף א", "<h2>סימן ב</h2>", "סעיף א"] };
    const v3Links: V3Link[] = [
      { status: "NEW", sourceBook: comm, targetBook: base, sourceLineIndex: 2, targetLineIndex: 2, heRef: "שולחן ערוך, אורח חיים א", connectionType: "commentary" },
      { status: "EXISTING", sourceBook: comm, targetBook: base, sourceLineIndex: 4, targetLineIndex: 4, heRef: 'שו"ע, "ב"', connectionType: "reference" },
      { status: "EDITED", sourceBook: comm, targetBook: base, sourceLineIndex: 5, targetLineIndex: 4, connectionType: "other" },
    ];
    const ref = (b: V3Book, key: string): BookRef => ({ key, title: b.title, origin: "otzaria" });
    const links: Link[] = v3Links.map((l, i) => ({
      id: `u:${i}`,
      status: "new",
      provenance: "user",
      source: { book: ref(l.sourceBook, "s1:1"), line: l.sourceLineIndex },
      target: { book: ref(l.targetBook, "s1:2"), line: l.targetLineIndex },
      declaredType: l.connectionType,
      heRef2: l.heRef ?? "",
    }));
    const ours = planSefariaCsv(links, (b) => headingsOf(b.key === "s1:1" ? comm.lines : base.lines));
    const theirs = v3.buildCsv(v3Links);
    expect(ours.map((f) => [f.sourceTitle, f.text])).toEqual([...theirs.entries()]);
    expect(ours[0]!.name).toBe("פירוש, על השולחן.links.csv");
    expect(ours[0]!.rows).toBe(3);
  });

  it("one file per source book, sorted, rows in line order", () => {
    const A: BookRef = { key: "a", title: "ב ספר", origin: "otzaria" };
    const B: BookRef = { key: "b", title: "א ספר", origin: "otzaria" };
    const mk = (s: BookRef, line: number): Link => ({ id: `${s.key}${line}`, status: "new", provenance: "user", source: { book: s, line }, target: { book: A, line: 0 }, declaredType: "commentary", heRef2: `ref ${line}` });
    const files = planSefariaCsv([mk(A, 5), mk(B, 1), mk(A, 2)], () => undefined);
    expect(files.map((f) => f.name)).toEqual(["א ספר.links.csv", "ב ספר.links.csv"]);
    expect(files[1]!.text.split("\n").slice(1)).toEqual(["ב ספר,ref 2,commentary", "ב ספר,ref 5,commentary"]);
  });
});
