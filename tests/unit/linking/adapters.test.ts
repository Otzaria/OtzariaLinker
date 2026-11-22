import { describe, expect, it } from "vitest";
import type { SourceBook, SourceLine } from "../../../src/core/books";
import type { BookRef } from "../../../src/core/links/model";
import { runEngine, type EngineBook, type EngineId } from "../../../src/linking/automatic";
import { loadEngineBook, runPair, type BooksPort, type LinkerAdapters } from "../../../src/linking/adapters";

/*
 * Issue 9 (plugin readiness): a headless proof that the engines run through the adapter interface alone — in memory,
 * in Node, with no worker, no database reader and no DOM. The books are the generated pair of engine-steps.test.ts: a
 * base of distinct words under chapter headings, and a commentary quoting each line's opening words.
 */
const LETTERS = "אבגדהוזחטיכלמנסעפצקרשת";
const word = (n: number) => {
  let s = "";
  for (let k = 0; k < 3; k++, n = Math.floor(n / LETTERS.length)) s += LETTERS[n % LETTERS.length];
  return s;
};
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria" });
const BASE = ref("mem:base", "בסיס");
const COMM = ref("mem:comm", "פירוש על בסיס");

function texts(n: number): { base: string[]; comm: string[] } {
  const base: string[] = [];
  const comm: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 50 === 0) {
      const h = `<h2>פרק ${word(9000 + i / 50)}</h2>`;
      base.push(h);
      comm.push(h);
    }
    const w = [0, 1, 2, 3, 4, 5].map((k) => word(6 * i + k));
    base.push(w.join(" "));
    comm.push(`<b>${w[0]} ${w[1]} ${w[2]}.</b> פירוש`);
  }
  return { base, comm };
}

/** The ports over plain arrays: what a host with its own books would implement. */
function memoryBooks(content: Record<string, string[]>, reads: { n: number; widest: number }): BooksPort {
  const line = (text: string, index: number): SourceLine => ({ index, text, anchorText: text, heRef: null, heading: text.startsWith("<h2>") ? 2 : null, existsInDb: true });
  return {
    list: async (): Promise<SourceBook[]> => [BASE, COMM].map((b) => ({ ...b, lineCount: content[b.key]!.length })),
    lines: async (key, from, to) => {
      reads.n++;
      reads.widest = Math.max(reads.widest, to - from + 1);
      return content[key]!.slice(from, to + 1).map((t, i) => line(t, from + i));
    },
    headings: async (key) => content[key]!.flatMap((t, i) => (t.startsWith("<h2>") ? [i] : [])),
  };
}
const asEngineBook = (book: BookRef, ts: string[]): EngineBook => ({ book, lines: ts.map((text, index) => ({ index, text, heading: text.startsWith("<h2>") ? 2 : null, heRef: null })) });

describe("the engines through the adapter interface, headless", () => {
  const { base, comm } = texts(400);
  const content = { [BASE.key]: base, [COMM.key]: comm };

  it.each<EngineId>(["headings", "dibur-hamatchil"])("%s: runPair gives exactly what runEngine gives on the same lines", async (engine) => {
    const reads = { n: 0, widest: 0 };
    const adapters: LinkerAdapters = { books: memoryBooks(content, reads) };
    const through = await runPair(adapters, engine, COMM, BASE);
    const direct = runEngine(engine, asEngineBook(COMM, comm), asEngineBook(BASE, base));
    expect(through.suggestions.length).toBeGreaterThan(300);
    expect(through).toEqual(direct);
    // read in the port's small windows, never the whole book at once (a host API may cap a single read)
    expect(reads.widest).toBeLessThanOrEqual(200);
    expect(reads.n).toBeGreaterThan(4);
  });

  it("progress goes out through the port", async () => {
    const calls: [number, number][] = [];
    await runPair({ books: memoryBooks(content, { n: 0, widest: 0 }), progress: (d, t) => calls.push([d, t]) }, "headings", COMM, BASE);
    expect(calls.length).toBeGreaterThan(0);
    const last = calls.at(-1)!;
    expect(last[0]).toBe(last[1]);
  });

  it("cancel stops the run: reading and the engine both honour the signal", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runPair({ books: memoryBooks(content, { n: 0, widest: 0 }), cancel: ac.signal }, "headings", COMM, BASE)).rejects.toThrow();

    // aborted while the engine runs: it stops with what it found, flagged in its notes
    const mid = new AbortController();
    const seen: number[] = [];
    const result = await runPair(
      { books: memoryBooks(content, { n: 0, widest: 0 }), cancel: mid.signal, progress: (d) => (seen.push(d), d > 20 && mid.abort()) },
      "dibur-hamatchil",
      COMM,
      BASE,
    );
    expect(result.suggestions.length).toBeLessThan(400);
    expect(result.notes.some((n) => n.code === "engine/aborted")).toBe(true);
  });

  it("loadEngineBook keeps the anchor text and heading facts the engines read", async () => {
    const b = await loadEngineBook(memoryBooks(content, { n: 0, widest: 0 }), BASE);
    expect(b.lines).toHaveLength(base.length);
    expect(b.lines[0]).toMatchObject({ index: 0, heading: 2 });
    expect(b.lines[1]!.text).toBe(base[1]);
  });
});

describe("a host that caps a single read", () => {
  /** A port that never returns more than `cap` lines, whatever window it is asked for (a plugin's host API may do that). */
  function cappedBooks(total: number, cap: number): BooksPort {
    const line = (index: number): SourceLine => ({ index, text: `שורה ${index}`, anchorText: `שורה ${index}`, heRef: null, heading: null, existsInDb: true });
    return {
      list: async () => [],
      lines: async (_key, from, to) => Array.from({ length: Math.max(0, Math.min(to - from + 1, cap, total - from)) }, (_, i) => line(from + i)),
      headings: async () => [],
    };
  }

  it("loadEngineBook reads the whole book when the host returns fewer lines than asked", async () => {
    const b = await loadEngineBook(cappedBooks(1000, 50), BASE);
    expect(b.lines).toHaveLength(1000);
    expect(b.lines.map((l) => l.index)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });

  it("an empty read ends it, and a book that is shorter than one window is read once", async () => {
    expect((await loadEngineBook(cappedBooks(0, 50), BASE)).lines).toHaveLength(0);
    expect((await loadEngineBook(cappedBooks(7, 50), BASE)).lines).toHaveLength(7);
    expect((await loadEngineBook(cappedBooks(200, 200), BASE)).lines).toHaveLength(200);
  });

  it("a host that ignores the window cannot make it loop for ever", async () => {
    const stuck: BooksPort = { list: async () => [], headings: async () => [], lines: async () => [{ index: 0, text: "א", anchorText: "א", heRef: null, heading: null, existsInDb: true }] };
    const b = await loadEngineBook(stuck, BASE);
    expect(b.lines.length).toBeLessThan(3);
  });
});
