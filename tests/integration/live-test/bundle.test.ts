import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BASE,
  BOOKS_DIR,
  BUNDLE_BOOKS,
  GENESIS,
  UPDATE_INSERTED_LINE,
  buildLiveTestBundle,
  bundleBookLines,
  validationContext,
  type LiveTestBundle,
} from "../../../scripts/live-test/bundle";
import { sefariaRefFromHeRef } from "../../../src/core/links/sefaria-ref";
import { titleFromPath2 } from "../../../src/core/links/titles";
import { validateExport } from "../../../src/core/links/validate";
import { anchorLabelFromHeRef } from "../../../src/core/text/anchor-label";
import { countVisibleChars } from "../../../src/core/text/offsets";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { recordToLink } from "../../../src/formats/links-json/convert";
import { parseLinksJson } from "../../../src/formats/links-json/parse";

/*
 * The stage-20 bundle (scripts/live-test/bundle.ts, docs/LIVE_TESTING.md): what it writes must pass
 * the tool's own validation and parser, and the gates of the Otzaria app's personal import as they
 * are on Otzaria/otzaria upstream/dev@ceff2b13 (mirrored below with file:line). The app itself is
 * NOT run here — that is the manual part, recorded in docs/LIVE_TESTING.md.
 */
let bundle: LiveTestBundle;
beforeAll(() => {
  bundle = buildLiveTestBundle();
});

const linksFiles = (dir: string) => bundle.files.filter((f) => f.path.startsWith(`${dir}/`) && f.path.endsWith("_links.json"));
const fileText = (path: string) => bundle.files.find((f) => f.path === path)!.text;
const bookLines = (title: string, dir = BOOKS_DIR) => bundleBookLines(fileText(`${dir}/${title}.txt`));

describe("the bundle is what the tool writes", () => {
  it("is deterministic: two builds give the same bytes", () => {
    expect(buildLiveTestBundle().files).toEqual(bundle.files);
  });

  it("nothing is held back, and the tool's validation has no error and no warning on the main links", () => {
    for (const plan of [bundle.plans.main, bundle.plans.update, bundle.plans.negative]) expect(plan.heldBack).toEqual([]);
    const main = bundle.cases.filter((c) => c.id.startsWith("L"));
    expect(main).toHaveLength(12);
    for (const c of main) expect(c.tool.filter((p) => p.severity !== "info"), c.id).toEqual([]);
    // the same verdict from validateExport itself, on the moved links of check 15
    const updated = { ...BUNDLE_BOOKS, [BASE]: bookLines(BASE, "update") };
    const problems = validateExport(bundle.plans.update.written, validationContext(updated));
    expect([...problems.values()].flat().filter((p) => p.severity !== "info")).toEqual([]);
  });

  it("the negative file carries exactly the record the tool only warns about", () => {
    const n = bundle.cases.filter((c) => c.id.startsWith("N"));
    expect(n.map((c) => [c.id, c.tool.map((p) => `${p.severity}:${p.code}`)])).toEqual([
      ["N1a", []],
      ["N1b", ["warning:export/unknown-type"]],
    ]);
  });

  it("every links file passes the tool's own parser and the library's byte rules, and reads back as the same links", () => {
    const files = [...linksFiles(BOOKS_DIR), ...linksFiles("update"), ...linksFiles("negative")];
    expect(files.length).toBe(5 + 3 + 1);
    for (const f of files) {
      const parsed = parseLinksJson(f.text);
      // the generator stores an unknown type as OTHER: the tool's parser only warns (the app rejects it, below)
      expect(parsed.issues.map((x) => `${x.level}:${x.code}`), f.path).toEqual(f.path.startsWith("negative/") ? ["warning:record/unknown-type"] : []);
      expect(parsed.generatorRejectsFile || parsed.pipelineRejectsBytes, f.path).toBe(false);
      expect(f.text.endsWith("\n")).toBe(false);
    }
    for (const f of linksFiles(BOOKS_DIR)) {
      const title = f.path.slice(`${BOOKS_DIR}/`.length, -"_links.json".length);
      const book = { key: `txt:${title}`, title, origin: "otzaria" as const };
      const back = parseLinksJson(f.text).records.map((r, i) => recordToLink(r, i, book, (t) => ({ key: t, title: t, origin: "otzaria" }), `r${i}`).link);
      const written = bundle.plans.main.written.filter((l) => l.source.book.title === title);
      expect(back.map((l) => [l.source.line, l.source.end, l.target.book.title, l.target.line, l.target.end, l.declaredType, l.anchor?.rawStart, l.anchor?.rawEnd])).toEqual(
        written.map((l) => [l.source.line, l.source.end, l.target.book.title, l.target.line, l.target.end, l.declaredType, l.anchor?.rawStart, l.anchor?.rawEnd]),
      );
    }
  });

  it("the manifest points at the right record of each file", () => {
    const manifest = JSON.parse(fileText("manifest.json")) as { cases: { id: string; file: string; record: number; from: string; to: string }[] };
    expect(manifest.cases.map((c) => c.id)).toEqual([...Array.from({ length: 12 }, (_, i) => `L${i + 1}`), "N1a", "N1b"]);
    for (const c of manifest.cases) {
      const records = JSON.parse(fileText(c.file)) as { line_index_1: number; path_2: string }[];
      const r = records[c.record - 1]!;
      expect(c.from.endsWith(`:${r.line_index_1}`) || c.from.includes(`:${r.line_index_1}-`), c.id).toBe(true);
      expect(c.to.startsWith(`${titleFromPath2(r.path_2)}:`), c.id).toBe(true);
    }
  });
});

describe("anchors land on the intended words", () => {
  const records = () => JSON.parse(fileText(`${BOOKS_DIR}/${BASE}_links.json`)) as { line_index_1: number; start?: number; end?: number; heRef_2: string }[];

  it("L2: the range anchor covers exactly יעקב, behind a <b> tag (raw ≠ visible)", () => {
    const r = records().find((x) => x.line_index_1 === 4)!;
    const line = bookLines(BASE)[3]!;
    expect(line.slice(r.start, r.end)).toBe("יעקב");
    expect(countVisibleChars(line, r.start)).toBeLessThan(r.start!); // the tags before it are not counted
  });

  it("L3: the point anchor sits right before רחל and carries the label א in heRef_2", () => {
    const r = records().find((x) => x.line_index_1 === 5)!;
    const line = bookLines(BASE)[4]!;
    expect(r.end).toBeUndefined();
    expect(line.slice(r.start!).startsWith("רחל")).toBe(true);
    expect(anchorLabelFromHeRef(r.heRef_2)).toBe("א");
    // the app's own label rule: the FIRST "אות X" in the heRef (user_import_parser.dart:578-590)
    expect(/(?:^|[,\s])אות\s+([א-ת][א-ת'"׳״]*)/.exec(r.heRef_2)?.[1]).toBe("א");
  });

  it("L4: the base line prints (1) and the note line opens with (1) (numbered_note_markers.dart:12,24-27)", () => {
    expect(/\(\d{1,4}\)/.exec(bookLines(BASE)[5]!)?.[0]).toBe("(1)");
    expect(/^\s*\(\s*(\d{1,4})\s*\)/.exec(bookLines("הערות לבדיקת מקשר")[1]!)?.[1]).toBe("1");
  });
});

/*
 * The gates of the app's native import of `<book>_links.json` (personal folder and Settings import),
 * Otzaria/otzaria upstream/dev@ceff2b13:
 *   user_content_importer.dart:67-84   — the file kind comes from its name (`_links.json`)
 *   user_content_importer.dart:224-232 — the base (source) title is the file name minus `_links.json`
 *   user_import_parser.dart:458-502    — line_index_1/2 ≥ 1, path_2 present, _end ≥ start, known type
 *   user_import_models.dart:35-60      — the 24 known types (plus aliases, link_types.dart:42-53)
 *   user_link_ref_resolver.dart:139-166 — exact title; in both libraries = ambiguous
 *   user_content_importer.dart:616-647 — lines within totalLines (when the book declares them)
 * ONE failing record rejects the whole file (user_content_importer.dart:142-144).
 */
const APP_NATIVE_TYPES = new Set([
  "COMMENTARY", "SUPER_COMMENTARY", "TARGUM", "REFERENCE", "SOURCE", "MIDRASH", "QUOTATION", "MESORAT_HASHAS",
  "EIN_MISHPAT", "DIBUR_HAMATCHIL", "PARSHANUT", "MISHNAH_IN_TALMUD", "RELATED", "OTHER", "LINKER", "SIFREI_MITZVOT",
  "ESSAY", "ALLUSION", "LITURGY", "ELUCIDATION", "EXPLICATION", "LAW", "SUMMARY", "FOOTNOTES",
]);
const appType = (raw: unknown) => String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");

function appNativeGate(path: string, text: string, totalLines: (title: string) => number | undefined): string[] {
  const errors: string[] = [];
  const name = path.split("/").at(-1)!;
  if (!name.toLowerCase().endsWith("_links.json")) return [`${name}: not a native links file`];
  const base = name.slice(0, -"_links.json".length);
  const baseLines = totalLines(base);
  if (baseLines === undefined) errors.push(`${name}: base book "${base}" not found`);
  (JSON.parse(text) as Record<string, unknown>[]).forEach((r, i) => {
    const li1 = r.line_index_1 as number;
    const li2 = r.line_index_2 as number;
    if (!Number.isInteger(li1) || li1 < 1) errors.push(`${i + 1}: line_index_1`);
    if (!Number.isInteger(li2) || li2 < 1) errors.push(`${i + 1}: line_index_2`);
    if (typeof r.path_2 !== "string" || !r.path_2.trim()) errors.push(`${i + 1}: path_2`);
    if (r.line_index_1_end !== undefined && (r.line_index_1_end as number) < li1) errors.push(`${i + 1}: line_index_1_end`);
    if (r.line_index_2_end !== undefined && (r.line_index_2_end as number) < li2) errors.push(`${i + 1}: line_index_2_end`);
    if (!APP_NATIVE_TYPES.has(appType(r["Conection Type"]))) errors.push(`${i + 1}: unknown type "${String(r["Conection Type"])}"`);
    const target = titleFromPath2(String(r.path_2)).trim();
    const targetLines = totalLines(target);
    if (targetLines === undefined) errors.push(`${i + 1}: target "${target}" not found`);
    if (baseLines && (li1 > baseLines || ((r.line_index_1_end as number | undefined) ?? 0) > baseLines)) errors.push(`${i + 1}: source line out of range`);
    if (targetLines && (li2 > targetLines || ((r.line_index_2_end as number | undefined) ?? 0) > targetLines)) errors.push(`${i + 1}: target line out of range`);
  });
  return errors;
}

describe("the app's personal import accepts the bundle (gates mirrored from Otzaria upstream/dev)", () => {
  const lines = (dir: string) => (title: string): number | undefined =>
    title === GENESIS.title ? GENESIS.totalLines : bundle.files.some((f) => f.path === `${dir}/${title}.txt`) ? bookLines(title, dir).length : dir !== BOOKS_DIR ? lines(BOOKS_DIR)(title) : undefined;

  it("the books folder: every file passes every gate", () => {
    for (const f of linksFiles(BOOKS_DIR)) expect(appNativeGate(f.path, f.text, lines(BOOKS_DIR)), f.path).toEqual([]);
  });

  it("update/: the moved links pass against the new edition", () => {
    for (const f of linksFiles("update")) expect(appNativeGate(f.path, f.text, lines("update")), f.path).toEqual([]);
  });

  it("negative/: exactly one record fails — and that rejects the whole file in the app", () => {
    const [f] = linksFiles("negative");
    expect(appNativeGate(f!.path, f!.text, lines(BOOKS_DIR))).toEqual(['1: unknown type "commentry"']);
  });

  it("no link end is a heading line (the app does not check, the generator drops it)", () => {
    for (const l of bundle.plans.main.written)
      for (const s of [l.source, l.target])
        if (s.book.title !== GENESIS.title) expect(bookLines(s.book.title)[s.line]!.startsWith("<h"), `${s.book.title}:${s.line + 1}`).toBe(false);
  });
});

describe("check 15: the content update", () => {
  it("the new edition is the old one with one line inserted after the title", () => {
    const before = bookLines(BASE);
    const after = bookLines(BASE, "update");
    expect(after).toEqual([before[0], UPDATE_INSERTED_LINE, ...before.slice(1)]);
  });

  it("every moved link points at the same TEXT it pointed at before", () => {
    const before = bookLines(BASE);
    const after = bookLines(BASE, "update");
    const old = new Map(bundle.plans.main.written.map((l) => [l.id, l]));
    let moved = 0;
    for (const l of bundle.plans.update.written) {
      const o = old.get(l.id)!;
      for (const k of ["source", "target"] as const) {
        if (l[k].book.title !== BASE) continue;
        expect(after[l[k].line], l.id).toBe(before[o[k].line]);
        if (l[k].end !== undefined) expect(after[l[k].end!], l.id).toBe(before[o[k].end!]);
        moved++;
      }
      expect(l.anchor).toEqual(o.anchor); // identical line: the raw offsets stay
    }
    expect(moved).toBe(8);
    expect(Object.keys(bundle.relinked).sort()).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L9"]);
  });
});

describe("the official book's facts, against the real database slice", () => {
  it("בראשית: a Sefaria base book with these lines and heRefs; the refs are the tool's", async () => {
    const reader = await OtzariaDbReader.open(bytesSource(new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"))));
    const books = await reader.books();
    const g = books.find((b) => b.title === GENESIS.title)!;
    expect(g).toMatchObject({ isBaseBook: true, totalLines: GENESIS.totalLines });
    expect(g.source?.toLowerCase()).toContain("sefaria");
    const lines = await reader.lines(g.id, 0, 7);
    for (const [i, heRef] of Object.entries(GENESIS.heRefs)) {
      const line = lines.find((l) => l.index === Number(i))!;
      expect(line.heRef).toBe(heRef);
      expect(line.content.startsWith("<h")).toBe(false);
    }
    expect([2, 3, 4, 5].map((i) => sefariaRefFromHeRef(GENESIS.heRefs[i]))).toEqual(["Genesis 1:1", "Genesis 1:2", "Genesis 1:3", "Genesis 1:4"]);
    for (const title of Object.keys(BUNDLE_BOOKS)) expect(books.some((b) => b.title === title), title).toBe(false);
  });
});

describe("make-bundle.mjs", () => {
  it("writes exactly the built files, as UTF-8 without BOM", () => {
    const out = mkdtempSync(join(tmpdir(), "live-test-"));
    try {
      execFileSync(process.execPath, ["scripts/live-test/make-bundle.mjs", join(out, "bundle")], { encoding: "utf8" });
      for (const f of bundle.files) {
        const bytes = readFileSync(join(out, "bundle", ...f.path.split("/")));
        expect(bytes[0], f.path).not.toBe(0xef);
        expect(bytes.toString("utf8"), f.path).toBe(f.text);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
