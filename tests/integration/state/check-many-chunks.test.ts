import { describe, expect, it } from "vitest";
import type { SourceBook, SourceLine } from "../../../src/core/books";
import type { BookRef, Link } from "../../../src/core/links/model";
import { validateExport } from "../../../src/core/links/validate";
import { addChanges, commit } from "../../../src/state/history";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, OpenedSource } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

/*
 * Review C7: the export check read line facts from the views' cache (400 chunks, FIFO). A project
 * whose links need more chunks lost the first ones before the check read them: their "heading line"
 * errors became "line not verified" (info), and the links were written.
 *
 * Two books of 200,000 lines, a heading every 200 lines; 500 links, each from a content line of one
 * book to a heading of the other, every end in its own chunk: 1,000 chunks.
 */
const N = 200_000;
const books: SourceBook[] = [
  { key: "s1:1", title: "פירוש", origin: "otzaria", lineCount: N },
  { key: "s1:2", title: "בסיס", origin: "otzaria", lineCount: N },
];
const line = (index: number): SourceLine => {
  const heading = index % 200 === 0;
  const text = heading ? `<h2>סימן ${index / 200}</h2>` : `שורה ${index}`;
  return { index, text, anchorText: heading ? `סימן ${index / 200}` : text, heRef: null, heading: heading ? 2 : null, existsInDb: true };
};
let reads = 0;
const service = {
  open: async (): Promise<{ sources: OpenedSource[]; documents: []; skipped: [] }> => ({ sources: [{ info: { id: "s1", kind: "otzaria-db", label: "x.db", warnings: [] }, books }], documents: [], skipped: [] }),
  lines: async (_key: string, from: number, to: number) => (reads++, Array.from({ length: Math.min(to, N - 1) - from + 1 }, (_, i) => line(from + i))),
  // the database already has every project link: one in each chunk of the commentary
  existingLinks: async (key: string, from: number) => (key === "s1:1" && (from / 200) % 2 === 0 ? [dbLink(from / 400)] : []),
} as unknown as BooksService;
const ref = (b: SourceBook): BookRef => ({ key: b.key, title: b.title, origin: b.origin });
const linkK = (k: number): Link => ({
  id: `u:${k}`,
  status: "new",
  provenance: "user",
  source: { book: ref(books[0]!), line: 400 * k + 5 },
  target: { book: ref(books[1]!), line: 400 * k + 200 },
  declaredType: "commentary",
  heRef2: "בסיס",
});
const dbLink = (k: number): Link => ({ ...linkK(k), id: `db:${k}`, status: "existing", provenance: "db" });

describe("the export check on more chunks than the cache holds (review C7)", () => {
  it("every link to a heading line is an error, however many chunks the check reads", async () => {
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    await store.openFiles([{ path: "x.db", blob: new Blob([]) }]);
    const links = Array.from({ length: 500 }, (_, k) => linkK(k));
    store.linkState.value = commit(store.linkState.value, "test", addChanges(links));
    // a reader showing other lines meanwhile fills the cache with chunks the check does not need
    for (let c = 0; c < 50; c++) store.lines.line("s1:1", 400 * c + 205);

    expect(await store.loadLinkLines("בודק")).toBe(true);
    const problems = validateExport(store.allLinks.value, store.validation());
    const codes = links.map((l) => (problems.get(l.id) ?? []).map((p) => p.code));
    expect(codes.filter((c) => c.includes("export/heading-line"))).toHaveLength(500);
    expect(codes.filter((c) => c.includes("export/line-not-verified"))).toHaveLength(0);
    // and every one is found in the database (the database links read around them are kept for the check too)
    expect(codes.filter((c) => c.includes("export/in-db"))).toHaveLength(500);
    expect(reads).toBeGreaterThanOrEqual(1000);
  });
});
