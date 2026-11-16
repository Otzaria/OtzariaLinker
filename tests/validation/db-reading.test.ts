import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rowsToEntries } from "../../src/core/alt-toc/model";
import { DbLinksReader } from "../../src/database/otzaria/links-reader";
import { rehydrateLine } from "../../src/database/otzaria/line-notes";
import { OtzariaDbReader } from "../../src/database/otzaria/reader";
import { blobSource } from "../../src/database/sqlite/lazy/byte-source";
import type { SourceBook } from "../../src/core/books";
import { SourceRegistry } from "../../src/sources/registry";
import { canonicalRow, cleanupTmp, DB, fileBlob, fingerprint, h, ms, oracle, record, tally } from "./env";

/*
 * Check 1 — what the tool reads from the real seforim.db vs what SQLite itself says
 * (scripts/validation/db_oracle.py: Python sqlite3 + libzstd, read-only).
 *
 * Every book: title, source, isBaseBook, line count, category.
 * A deterministic sample (~320 books: every top category × source, the largest books, books with
 * line_note, alt_toc and line_divine_name): every line's text and heRef, the schema-7 notes, the
 * heading list vs tocEntry, alt_toc, and the existing links of two 40-line windows (link ids, type,
 * both ends, range ends, anchors, suppressed sides).
 *
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run --config vitest.validation.config.ts tests/validation/db-reading.test.ts
 */
interface OracleBook {
  id: number; title: string; source: string | null; categoryId: number; categoryPath: string[];
  isBaseBook: boolean | null; totalLines: number; lineCount: number; notes: number; divine: number; altToc: number;
}
interface Truth {
  id: number;
  lines: [number, string, string][];
  notes: Record<string, [number, boolean, string][]>;
  toc: [number | null, number, string][];
  altToc: { key: string; title: string | null; heTitle: string | null; rows: [number, number | null, string | null, number | null][] }[];
  windows: { from: number; lines: number; count: number; hash: string; rows?: string[]; perLine: number[]; denormBad: number }[];
}

describe.runIf(DB)("check 1: reading the real seforim.db vs SQLite (read-only)", () => {
  const before = DB ? fingerprint(DB) : "";
  let registry: SourceRegistry;
  let reader: OtzariaDbReader;
  let links: DbLinksReader;
  let sourceId: string;
  let listed: SourceBook[];
  let sampleFile: string;
  let books: OracleBook[];
  let sample: number[];
  const findings: Record<string, string[]> = {};
  const add = (kind: string, msg: string) => void (findings[kind] ??= []).push(msg);

  beforeAll(async () => {
    const o = JSON.parse(readFileSync(oracle("books", "books.json"), "utf8")) as { books: OracleBook[] };
    books = o.books;
    sampleFile = oracle("sample", "sample.json");
    sample = JSON.parse(readFileSync(sampleFile, "utf8")) as number[];
    registry = new SourceRegistry();
    const blob = await fileBlob(DB!);
    const opened = await registry.open([{ path: "seforim.db", blob }]);
    if (!opened.sources[0]) throw new Error(`not opened: ${JSON.stringify(opened)}`);
    sourceId = opened.sources[0].info.id;
    listed = opened.sources[0]!.books;
    reader = await OtzariaDbReader.open(blobSource(blob));
    links = (await DbLinksReader.open(reader.file, reader.caps))!;
  });
  afterAll(() => {
    cleanupTmp();
    expect(fingerprint(DB!)).toBe(before); // never written
  });

  it("metadata of every book", async () => {
    const ours = new Map((await reader.books()).map((b) => [b.id, b]));
    const theirs = new Map(listed.map((b) => [Number(b.key.split(":")[1]), b]));
    let checked = 0;
    for (const b of books) {
      const r = ours.get(b.id);
      const s = theirs.get(b.id);
      if (!r || !s) { add("metadata", `${b.id} ${b.title}: missing`); continue; }
      checked++;
      if (r.title !== b.title || s.title !== b.title) add("metadata", `${b.id}: title ${JSON.stringify(r.title)} ≠ ${JSON.stringify(b.title)}`);
      if (r.source !== b.source || (s.sourceName ?? null) !== b.source) add("metadata", `${b.id}: source ${r.source} ≠ ${b.source}`);
      if (r.isBaseBook !== b.isBaseBook || (s.isBaseBook ?? null) !== b.isBaseBook) add("metadata", `${b.id}: isBaseBook ${r.isBaseBook} ≠ ${b.isBaseBook}`);
      if (r.categoryId !== b.categoryId) add("metadata", `${b.id}: categoryId ${r.categoryId} ≠ ${b.categoryId}`);
      if (s.lineCount !== b.lineCount) add("metadata", `${b.id} ${b.title}: lineCount ${s.lineCount} ≠ ${b.lineCount} lines in SQLite`);
    }
    record("db-metadata", { books: books.length, ours: ours.size, checked, mismatches: findings["metadata"] ?? [] });
    expect(ours.size).toBe(books.length);
    expect(findings["metadata"] ?? []).toEqual([]);
  });

  it("lines, notes, headings, alt_toc and link windows of the sample", async () => {
    const truth = oracle("truth", "truth.jsonl", sampleFile);
    const byId = new Map(books.map((b) => [b.id, b]));
    const stats = { books: 0, lines: 0, notesLines: 0, notes: 0, tocEntries: 0, altStructures: 0, altEntries: 0, windows: 0, windowLinks: 0, windowsHashOnly: 0, denormBad: 0, ms: 0 };
    const toc = { equal: 0, differ: 0, kinds: [] as string[], examples: [] as string[] };
    const t0 = performance.now();
    const rl = createInterface({ input: createReadStream(truth, "utf8"), crlfDelay: Infinity });
    for await (const raw of rl) {
      const t = JSON.parse(raw) as Truth;
      const meta = byId.get(t.id)!;
      const key = `${sourceId}:${t.id}`;
      const tag = `${t.id} ${meta.title}`;
      stats.books++;

      // lines: count, order, text after zstd + dictionary, heRef
      const rows = await reader.lines(t.id);
      const src = await registry.lines(key, 0, Number.MAX_SAFE_INTEGER);
      if (rows.length !== t.lines.length || src.length !== t.lines.length) add("lines", `${tag}: ${rows.length}/${src.length} lines ≠ ${t.lines.length}`);
      let bad = 0;
      for (let i = 0; i < Math.min(rows.length, t.lines.length); i++) {
        const [index, content, heRef] = t.lines[i]!;
        const r = rows[i]!;
        stats.lines++;
        if (r.index !== index || src[i]!.index !== index) { if (bad++ < 3) add("lines", `${tag}: line #${i} index ${r.index} ≠ ${index}`); continue; }
        if (h(r.content) !== content || h(src[i]!.text) !== content) { if (bad++ < 3) add("lines", `${tag}: line ${index} text differs`); }
        if (h(r.heRef) !== heRef || h(src[i]!.heRef) !== heRef) { if (bad++ < 3) add("heRef", `${tag}: line ${index} heRef differs`); }
        // notes (schema 7) and the anchor text built from them
        const want = t.notes[String(index)] ?? [];
        const got = r.notes.map((n) => [n.charPos, n.hasMarker, h(n.body)] as const);
        if (JSON.stringify(got) !== JSON.stringify(want)) add("notes", `${tag}: line ${index} notes ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
        if (want.length) { stats.notesLines++; stats.notes += want.length; }
        const anchor = src[i]!.anchorText;
        if (!want.length && anchor !== r.content) add("anchorText", `${tag}: line ${index} without notes has anchorText ≠ text`);
        if (want.length && anchor !== rehydrateLine(r.content, r.notes)) add("anchorText", `${tag}: line ${index} anchorText is not the rehydrated line`);
      }

      // headings (the tool derives them from <hN> lines) vs the generator's tocEntry
      const heads = await registry.headings(key);
      stats.tocEntries += t.toc.length;
      const d = tocDiff(heads, t.toc);
      if (!d.length) toc.equal++;
      else {
        toc.differ++;
        const group = meta.source === "Sefaria" ? "Sefaria" : "Otzaria";
        for (const k of d) toc.kinds.push(`${group}: ${k.kind}`);
        for (const k of d) if (k.example && toc.examples.filter((e) => e.startsWith(`${group}: ${k.kind}`)).length < 4) toc.examples.push(`${group}: ${k.kind}: ${tag}: ${k.example}`);
      }

      // alt_toc: the reader vs the rows SQLite returns
      const alt = await registry.altToc(key);
      const wantAlt = t.altToc.map((s) => ({ key: s.key, ...(s.title && { title: s.title }), ...(s.heTitle && { heTitle: s.heTitle }), ...rowsToEntries(s.rows.map(([id, parentId, text, line]) => ({ id, parentId, text: text ?? "", line: line === null ? null : line + 1 }))) }));
      stats.altStructures += wantAlt.length;
      stats.altEntries += wantAlt.reduce((n, s) => n + s.entries.length, 0);
      if (JSON.stringify(alt ?? []) !== JSON.stringify(wantAlt)) add("altToc", `${tag}: ${JSON.stringify(alt).slice(0, 200)} ≠ ${JSON.stringify(wantAlt).slice(0, 200)}`);

      // existing links of the windows
      for (const w of t.windows) {
        stats.windows++;
        stats.denormBad += w.denormBad;
        const ids = rows.slice(w.from, w.from + w.lines).map((l) => l.lineId);
        const got = (await links.atLines(ids)).map(canonicalRow);
        stats.windowLinks += got.length;
        if (!w.rows) stats.windowsHashOnly++;
        if (got.length !== w.count || h(got.join("\n")) !== w.hash) {
          const extra = w.rows ? got.filter((x) => !w.rows!.includes(x)).slice(0, 3) : [];
          const missing = w.rows ? w.rows.filter((x) => !got.includes(x)).slice(0, 3) : [];
          add("links", `${tag}: window ${w.from}: ${got.length} links ≠ ${w.count}; ours-only ${JSON.stringify(extra)} sqlite-only ${JSON.stringify(missing)}`);
        }
        for (let i = 0; i < w.perLine.length; i++) {
          const n = (await links.atLines([ids[i]!])).length;
          if (n !== w.perLine[i]) add("links", `${tag}: line ${w.from + i}: ${n} links ≠ ${w.perLine[i]}`);
        }
        // the Link objects the UI gets: one per row
        const shown = await registry.existingLinks(key, w.from, w.from + w.lines - 1);
        if (shown.length !== w.count) add("links", `${tag}: existingLinks(${w.from}…) gave ${shown.length} ≠ ${w.count}`);
      }
    }
    stats.ms = ms(t0);
    const summary = record("db-reading", {
      stats,
      sample: { books: sample.length, byTop: tally(sample.map((id) => byId.get(id)!.categoryPath[0] ?? "?")), bySource: tally(sample.map((id) => byId.get(id)!.source ?? "?")), largest: sample.map((id) => byId.get(id)!).sort((a, b) => b.lineCount - a.lineCount).slice(0, 6).map((b) => `${b.title} (${b.lineCount})`) },
      toc: { equal: toc.equal, differ: toc.differ, kinds: tally(toc.kinds), examples: toc.examples },
      findings,
    });
    console.info(JSON.stringify({ stats: summary.stats, toc: { equal: toc.equal, differ: toc.differ, kinds: summary.toc.kinds }, findings: Object.fromEntries(Object.entries(findings).map(([k, v]) => [k, v.length])) }, null, 1));
    for (const k of ["lines", "heRef", "notes", "anchorText", "altToc", "links"]) expect(findings[k] ?? [], k).toEqual([]);
  });
});

/**
 * How the tool's heading list (lines that start with <h1>–<h6>) differs from the generator's tocEntry
 * rows of the same book, line by line: entries only on one side, a constant level offset, text.
 */
function tocDiff(ours: readonly { line: number; level: number; text: string }[], toc: readonly [number | null, number, string][]): { kind: string; example?: string }[] {
  const norm = (x: string) => x.replace(/\s+/g, " ").trim();
  const o = new Map(ours.map((x) => [x.line, x]));
  const t = new Map<number, { level: number; text: string }>();
  let noLine = 0;
  for (const [line, level, text] of toc) {
    if (line === null) noLine++;
    else if (!t.has(line)) t.set(line, { level, text: text ?? "" });
  }
  const out: { kind: string; example?: string }[] = [];
  const onlyOurs = [...o.keys()].filter((l) => !t.has(l));
  const onlyToc = [...t.keys()].filter((l) => !o.has(l));
  if (onlyOurs.length) out.push({ kind: "heading line without tocEntry", example: onlyOurs.slice(0, 3).map((l) => `${l}:${o.get(l)!.text.slice(0, 30)}`).join(" ; ") });
  if (onlyToc.length) out.push({ kind: "tocEntry on a non-heading line", example: onlyToc.slice(0, 3).map((l) => `${l}:${t.get(l)!.text.slice(0, 30)}`).join(" ; ") });
  if (noLine) out.push({ kind: "tocEntry without a line" });
  const offsets = new Set<number>();
  const texts: string[] = [];
  for (const [l, x] of o) {
    const y = t.get(l);
    if (!y) continue;
    offsets.add(x.level - y.level);
    if (norm(x.text) !== norm(y.text)) texts.push(`${l}: ${JSON.stringify(x.text.slice(0, 40))} vs ${JSON.stringify(y.text.slice(0, 40))}`);
  }
  const off = [...offsets].sort();
  if (off.length && !(off.length === 1 && off[0] === 0)) out.push({ kind: `level offset ${off.join("/")}` });
  if (texts.length) out.push({ kind: "text differs", example: texts.slice(0, 2).join(" ; ") });
  return out;
}
