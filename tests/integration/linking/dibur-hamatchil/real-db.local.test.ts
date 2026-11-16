import { closeSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ByteSource } from "../../../../src/database/sqlite/lazy/byte-source";
import { OtzariaDbReader } from "../../../../src/database/otzaria/reader";
import { DbLinksReader } from "../../../../src/database/otzaria/links-reader";
import { runDiburHamatchilEngine } from "../../../../src/linking/automatic/dibur-hamatchil";
import type { EngineBook } from "../../../../src/linking/automatic/types";
import { measure, type Measured } from "./measure";

/*
 * The ד"ה engine against whole books of a real Otzaria database, measured against the commentary
 * links the database already has. Runs only on a machine with the database:
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/dibur-hamatchil/real-db.local.test.ts
 * The file is opened read-only ("r") and never written. DH_REPORT=<path> writes every miss.
 */
const path = process.env.OTZARIA_DB;
const fd = path ? openSync(path, "r") : -1;
const source: ByteSource | null = path
  ? {
      size: fstatSync(fd).size,
      async read(offset, length) {
        const buf = new Uint8Array(length);
        const n = readSync(fd, buf, 0, length, offset);
        return buf.subarray(0, n);
      },
    }
  : null;
afterAll(() => {
  if (path) closeSync(fd);
});

describe.runIf(path)("ד\"ה engine on whole books of the real seforim.db (read-only)", () => {
  let reader: OtzariaDbReader;
  let links: DbLinksReader;
  const report: string[] = [];
  beforeAll(async () => {
    reader = await OtzariaDbReader.open(source!);
    links = (await DbLinksReader.open(reader.file, reader.caps))!;
  });
  afterAll(() => {
    if (process.env.DH_REPORT) writeFileSync(process.env.DH_REPORT, report.join("\n"));
  });

  const bookOf = async (title: string): Promise<{ id: number; book: EngineBook; lineIds: number[] }> => {
    const b = (await reader.books()).find((x) => x.title === title)!;
    const lines = await reader.lines(b.id);
    return {
      id: b.id,
      lineIds: lines.map((l) => l.lineId),
      book: {
        book: { key: `db:${b.id}`, title: b.title, origin: b.source === "Sefaria" ? "sefaria" : "otzaria", isBaseBook: b.isBaseBook ?? undefined },
        lines: lines.map((l) => ({ index: l.index, text: reader.anchorText(l), heading: /^<h[1-6]/i.test(l.content) ? Number(l.content[2]) : null, heRef: l.heRef })),
      },
    };
  };

  async function run(commentaryTitle: string, baseTitle: string): Promise<Measured> {
    const c = await bookOf(commentaryTitle);
    const b = await bookOf(baseTitle);
    const gold = new Map<number, Set<number>>();
    for (const k of await links.atLines(c.lineIds))
      if (k.type === "COMMENTARY" && k.source.bookId === b.id && k.target.bookId === c.id)
        gold.set(k.target.lineIndex, (gold.get(k.target.lineIndex) ?? new Set()).add(k.source.lineIndex));
    const t0 = performance.now();
    const res = runDiburHamatchilEngine(c.book, b.book);
    const ms = performance.now() - t0;
    const m = measure(res, gold, (s) => s.source.line, (s) => s.target);
    report.push(`## ${commentaryTitle} → ${baseTitle}: ${JSON.stringify({ ...m, misses: undefined, ms: Math.round(ms) })}`, ...m.misses);
    console.log(commentaryTitle, "→", baseTitle, { ...m, misses: m.misses.length, ms: Math.round(ms) });
    return m;
  }

  it('רש"י על בראשית → בראשית', async () => {
    const m = await run('רש"י על בראשית', "בראשית");
    expect(m.precision).toBeGreaterThanOrEqual(0.95);
    expect(m.recall).toBeGreaterThanOrEqual(0.6);
  }, 600_000);

  it('רש"י על ברכות → ברכות', async () => {
    const m = await run('רש"י על ברכות', "ברכות");
    expect(m.precision).toBeGreaterThanOrEqual(0.9);
  }, 600_000);

  it("תוספות על ברכות → ברכות", async () => {
    const m = await run("תוספות על ברכות", "ברכות");
    expect(m.precision).toBeGreaterThanOrEqual(0.9);
  }, 600_000);
});
