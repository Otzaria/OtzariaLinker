import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countVisibleChars, rawOffsetFromVisible, visibleUnits } from "../../src/core/text/offsets";
import { otzariaBookTitle, sourceTitleFromLinksFileName } from "../../src/core/links/titles";
import { decodeText } from "../../src/core/text/decode";
import { parseLinksJson } from "../../src/formats/links-json/parse";
import { OtzariaDbReader, type DbBook, type DbLine } from "../../src/database/otzaria/reader";
import { blobSource } from "../../src/database/sqlite/lazy/byte-source";
import { cleanupTmp, DB, fileBlob, fingerprint, gitBlobs, gitFiles, LIBRARY, ms, oracle, record, tally, tmpDir } from "./env";

/*
 * Check 2 — word anchors (link_anchor) of the real database against the tool's anchor model
 * (src/core/text/offsets.ts: the generator's HtmlCharCounter; src/database/otzaria/line-notes.ts:
 * LineNoteRehydration). link_anchor offsets are VISIBLE characters of the full line (schema 7: with
 * the line_note bodies put back); a `_links.json` carries RAW offsets into the book's line.
 *
 * A. A deterministic sample of anchors of every connection type: in range of the visible line; the
 *    raw offset the tool would export maps back to the same visible offset (the generator accepts
 *    it and stores the same anchor); and the anchor starts/ends at a word boundary (the sign that the
 *    offsets land where the generator meant — measured with and without the note bodies).
 * B. (with OTZARIA_LIBRARY) Every record with `start` in the live link roots whose link the database
 *    stored in the file's direction: countVisibleChars(line, start) — the tool's conversion — must be
 *    one of the link's stored charStart values (and `end` → charEnd).
 *
 *   OTZARIA_DB=… [OTZARIA_LIBRARY=…] npx vitest run --config vitest.validation.config.ts tests/validation/anchors.test.ts
 */
const PER_TYPE = 400;
const WORD = /[\p{L}\p{M}\p{N}]/u;

describe.runIf(DB)("check 2: anchors of the real database vs the tool's anchor model", () => {
  const before = DB ? fingerprint(DB) : "";
  let reader: OtzariaDbReader;
  let books: Map<number, DbBook>;
  const cache = new Map<string, DbLine | undefined>();
  const lineOf = async (bookId: number, index: number): Promise<DbLine | undefined> => {
    const k = `${bookId}:${index}`;
    if (!cache.has(k)) cache.set(k, (await reader.lines(bookId, index, index))[0]);
    return cache.get(k);
  };

  beforeAll(async () => {
    reader = await OtzariaDbReader.open(blobSource(await fileBlob(DB!)));
    books = new Map((await reader.books()).map((b) => [b.id, b]));
  });
  afterAll(() => {
    cleanupTmp();
    expect(fingerprint(DB!)).toBe(before);
  });

  it("A: a sample of link_anchor rows of every type", async () => {
    const t0 = performance.now();
    const rows = JSON.parse(readFileSync(oracle("anchors", "anchors.json", String(PER_TYPE)), "utf8")) as {
      linkId: number; type: string; side: 0 | 1; charStart: number; charEnd: number | null; label: string | null; bookId: number; lineIndex: number;
    }[];
    const bad: string[] = [];
    const perType: Record<string, { n: number; inRange: number; roundTrip: number; startWord: number; endWord: number; ranges: number }> = {};
    const notes = { lines: 0, startWordWith: 0, startWordWithout: 0, endWordWith: 0, endWordWithout: 0, inRangeWithout: 0 };
    for (const a of rows) {
      const line = await lineOf(a.bookId, a.lineIndex);
      const s = (perType[`${a.type}/side${a.side}`] ??= { n: 0, inRange: 0, roundTrip: 0, startWord: 0, endWord: 0, ranges: 0 });
      s.n++;
      if (!line) { bad.push(`${a.linkId}: line ${a.bookId}:${a.lineIndex} not found`); continue; }
      const text = reader.anchorText(line);
      const vis = visibleString(text);
      const L = vis.length;
      const end = a.charEnd ?? undefined;
      if (end !== undefined) s.ranges++;
      const inRange = a.charStart >= 0 && a.charStart <= L && (end === undefined || (end >= a.charStart && end <= L));
      if (inRange) s.inRange++;
      else bad.push(`${a.linkId} ${a.type}: [${a.charStart},${end ?? ""}) outside ${L} visible chars (${books.get(a.bookId)?.title} ${a.lineIndex})`);
      // what the tool would write to start/end, and what the generator makes of it
      const rs = rawOffsetFromVisible(text, a.charStart);
      const re = end === undefined ? undefined : rawOffsetFromVisible(text, end);
      const accepted = rs >= 0 && rs <= text.length && (re === undefined || (re >= rs && re <= text.length));
      if (accepted && countVisibleChars(text, rs) === a.charStart && (re === undefined || countVisibleChars(text, re) === end)) s.roundTrip++;
      else if (inRange) bad.push(`${a.linkId} ${a.type}: export of [${a.charStart},${end ?? ""}) does not round-trip (raw ${rs},${re ?? ""})`);
      const sw = a.charStart === 0 || !WORD.test(vis[a.charStart - 1] ?? "");
      const ew = end === undefined || end >= L || !WORD.test(vis[end] ?? "");
      if (sw) s.startWord++;
      if (ew) s.endWord++;
      if (line.notes.length) {
        // the same anchor measured on the stored line WITHOUT the note bodies
        const plain = visibleString(line.content);
        notes.lines++;
        if (sw) notes.startWordWith++;
        if (ew) notes.endWordWith++;
        if (a.charStart === 0 || !WORD.test(plain[a.charStart - 1] ?? "")) notes.startWordWithout++;
        if (end === undefined || end >= plain.length || !WORD.test(plain[end] ?? "")) notes.endWordWithout++;
        if (a.charStart <= plain.length && (end === undefined || end <= plain.length)) notes.inRangeWithout++;
      }
    }
    const summary = record("anchors-db", { anchors: rows.length, types: tally(rows.map((r) => r.type)), perType, notes, bad: bad.slice(0, 40), badCount: bad.length, ms: ms(t0) });
    console.info(JSON.stringify(summary, null, 1));
    expect(bad).toEqual([]);
  });

  it.runIf(LIBRARY)("B: anchors written from library files vs the stored link_anchor", async () => {
    const t0 = performance.now();
    const sync = JSON.parse(readFileSync(join(LIBRARY!, "manual_links_sync.json"), "utf8")) as { links_roots: { path: string; expected_state: string }[] };
    const roots = sync.links_roots.filter((r) => r.expected_state === "present").map((r) => `${r.path}/`);
    const files = gitFiles(LIBRARY!, (p) => p.endsWith("_links.json") && roots.some((r) => p.startsWith(r)));
    const byTitle = new Map<string, DbBook>();
    for (const b of books.values()) if (!byTitle.has(b.title)) byTitle.set(b.title, b);
    const queries: { k: string; s: string; si: number; t: string; ti: number; start: number; end?: number; file: string }[] = [];
    for (const [f, bytes] of gitBlobs(LIBRARY!, files)) {
      const parsed = parseLinksJson(decodeText(bytes).text);
      const source = sourceTitleFromLinksFileName(f.path)!;
      parsed.records.forEach((r, i) => {
        if (r.start === undefined) return;
        const target = r.path_2.split(/[\\/]/).at(-1)!.replace(/\.[^.]*$/, "");
        queries.push({ k: `${f.path}#${i + 1}`, s: source, si: Math.max(0, Math.trunc(r.line_index_1) - 1), t: target, ti: Math.max(0, Math.trunc(r.line_index_2) - 1), start: r.start, ...(r.end !== undefined && { end: r.end }), file: f.path });
      });
    }
    const q = join(tmpDir(), "anchor-presence.jsonl");
    writeFileSync(q, queries.map((x) => JSON.stringify({ k: x.k, s: x.s, si: x.si, t: x.t, ti: x.ti })).join("\n") + "\n");
    const answers = new Map(readFileSync(oracle("presence", "anchor-presence-out.jsonl", q), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { k: string; links: { dir: string; anchors: [number, number, number | null, string | null][] }[] }).map((a) => [a.k, a]));

    const outcome: string[] = [];
    const bad: string[] = [];
    let matched = 0, matchedEnd = 0, withEnd = 0, txtSame = 0, txtChecked = 0;
    for (const x of queries) {
      const a = answers.get(x.k)!;
      const same = a.links.filter((l) => l.dir === "same");
      if (!a.links.length) { outcome.push("link not stored"); continue; }
      if (!same.length) { outcome.push("stored flipped (anchor dropped by design)"); continue; }
      const anchors = same.flatMap((l) => l.anchors.filter((y) => y[0] === 0));
      if (!anchors.length) { outcome.push("stored without anchor"); continue; }
      const book = byTitle.get(x.s) ?? byTitle.get(otzariaBookTitle(x.s));
      const line = book && (await lineOf(book.id, x.si));
      if (!line) { outcome.push("source line not readable"); continue; }
      const text = reader.anchorText(line);
      const cs = countVisibleChars(text, x.start);
      const hit = anchors.find((y) => y[1] === cs);
      if (!hit) {
        outcome.push("charStart differs");
        if (bad.length < 30) bad.push(`${x.k}: start ${x.start} → visible ${cs}, stored ${anchors.map((y) => y[1]).join("/")}`);
        continue;
      }
      matched++;
      outcome.push("charStart matches");
      if (x.end !== undefined && x.end >= x.start && x.end <= text.length) {
        withEnd++;
        if (hit[2] === countVisibleChars(text, x.end)) matchedEnd++;
        else if (bad.length < 30) bad.push(`${x.k}: end ${x.end} → visible ${countVisibleChars(text, x.end)}, stored ${hit[2]}`);
      }
      // the raw offset the tool would write for the stored anchor maps back to it
      txtChecked++;
      if (countVisibleChars(text, rawOffsetFromVisible(text, hit[1])) === hit[1]) txtSame++;
    }
    const summary = record("anchors-library", { recordsWithStart: queries.length, files: new Set(queries.map((q) => q.file)).size, outcome: tally(outcome), matched, withEnd, matchedEnd, exportRoundTrip: `${txtSame}/${txtChecked}`, bad, ms: ms(t0) });
    console.info(JSON.stringify(summary, null, 1));
    expect(outcome.filter((o) => o === "charStart differs").length).toBe(0);
  });
});

/** The visible characters of a line as one string (an entity is one placeholder character). */
function visibleString(html: string): string {
  return visibleUnits(html).map((u) => (u.end - u.start === 1 ? html[u.start] : "\u0000")).join("");
}
