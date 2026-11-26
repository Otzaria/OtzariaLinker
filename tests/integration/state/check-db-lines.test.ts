import { describe, expect, it } from "vitest";
import type { SourceBook, SourceLine } from "../../../src/core/books";
import type { BookRef, Link } from "../../../src/core/links/model";
import { validateExport } from "../../../src/core/links/validate";
import { addChanges, commit } from "../../../src/state/history";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, OpenedSource } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

/*
 * V7 §4.9 (docs/reviews/V7_PERFORMANCE.md §9): the quality check and the export decide "already in the database" by the database
 * links on a project link's own lines (core/links/equality.ts: the start lines). They read the links of the whole 200-line chunk
 * of every link end instead — on seforim.db a chunk of a heavily linked book (the Tanakh, the Talmud) holds tens of thousands, and
 * the check of 249 approved links read for 9 minutes. The check reads the database links only at the lines its links stand on,
 * and still finds every link the database has.
 */
const N = 10_000;
const books: SourceBook[] = [
  { key: "s1:1", title: "פירוש", origin: "otzaria", lineCount: N },
  { key: "s1:2", title: "בסיס", origin: "otzaria", lineCount: N },
];
const ref = (b: SourceBook): BookRef => ({ key: b.key, title: b.title, origin: b.origin });
const line = (index: number): SourceLine => ({ index, text: `שורה ${index}`, anchorText: `שורה ${index}`, heRef: null, heading: null, existsInDb: true });
const project = (k: number): Link => ({
  id: `u:${k}`,
  status: "new",
  provenance: "user",
  source: { book: ref(books[0]!), line: 700 * k + 5 },
  target: { book: ref(books[1]!), line: 700 * k + 9 },
  declaredType: "commentary",
  heRef2: "בסיס",
});
// the database has the first five of the project's links (the same two lines); and, on every line, a link to a third book
const db = (k: number): Link => ({ ...project(k), id: `db:${k}`, status: "existing", provenance: "db" });
const noise = (key: string, i: number): Link => ({ id: `db:n${key}:${i}`, status: "existing", provenance: "db", source: { book: ref(books.find((b) => b.key === key)!), line: i }, target: { book: { key: "s1:3", title: "אחר", origin: "otzaria" }, line: i }, declaredType: "reference", heRef2: "אחר" });

describe("the check reads the database links at its links' lines (V7 §4.9)", () => {
  it("only the lines the links stand on, and every link the database has is found", async () => {
    const calls: [string, number, number][] = [];
    const service = {
      open: async (): Promise<{ sources: OpenedSource[]; documents: []; skipped: [] }> => ({ sources: [{ info: { id: "s1", kind: "otzaria-db", label: "x.db", warnings: [] }, books }], documents: [], skipped: [] }),
      lines: async (_key: string, from: number, to: number) => Array.from({ length: Math.min(to, N - 1) - from + 1 }, (_, i) => line(from + i)),
      existingLinks: async (key: string, from: number, to: number) => {
        calls.push([key, from, to]);
        const out: Link[] = [];
        for (let i = from; i <= to; i++) out.push(noise(key, i));
        for (let k = 0; k < 5; k++) if ((key === "s1:1" && from <= 700 * k + 5 && 700 * k + 5 <= to) || (key === "s1:2" && from <= 700 * k + 9 && 700 * k + 9 <= to)) out.push(db(k));
        return out;
      },
    } as unknown as BooksService;
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    await store.openFiles([{ path: "x.db", blob: new Blob([]) }]);
    const links = Array.from({ length: 10 }, (_, k) => project(k));
    store.linkState.value = commit(store.linkState.value, "test", addChanges(links));

    calls.length = 0;
    expect(await store.loadLinkLines("בודק")).toBe(true);
    const own = new Set(links.flatMap((l) => [`${l.source.book.key}#${l.source.line}`, `${l.target.book.key}#${l.target.line}`]));
    const read = calls.flatMap(([key, from, to]) => Array.from({ length: to - from + 1 }, (_, i) => `${key}#${from + i}`));
    expect(read.filter((x) => !own.has(x))).toEqual([]);
    expect(new Set(read)).toEqual(own);

    const problems = validateExport(store.allLinks.value, store.validation());
    const inDb = links.filter((l) => (problems.get(l.id) ?? []).some((p) => p.code === "export/in-db")).map((l) => l.id);
    expect(inDb).toEqual(["u:0", "u:1", "u:2", "u:3", "u:4"]);
    // the quality check, the same rule
    expect((await store.quality.run())!.issues.filter((i) => i.problem.code === "export/in-db").map((i) => i.link.id).sort()).toEqual(inDb);
  });
});
