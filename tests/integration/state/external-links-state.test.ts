import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

/*
 * #13 through the state layer: the "links from the database" view of a personal database without a link table,
 * and "copy to the project" (db-copy) of those links — AGENTS §3: provenance "db" links are shown, never
 * exported as they are; a copy is a NEW link, made only when a file record can reproduce it (LINK_FORMATS §4.5).
 */
function makeStore() {
  const reg = new SourceRegistry();
  const service = {
    open: (f) => reg.open(f),
    openMapped: (t, m) => reg.openMapped(t, m),
    lines: (k, a, b) => reg.lines(k, a, b),
    existingLinks: (k, a, b) => reg.existingLinks(k, a, b),
    close: async (id) => reg.close(id),
    altToc: (k) => reg.altToc(k),
    headings: (k) => reg.headings(k),
    dbLinkSummary: (k, opts) => reg.dbLinkSummary(k, { ...(opts?.signal && { signal: opts.signal }) }),
    dbLinksPage: (k, query) => reg.dbLinksPage(k, query),
  } as BooksService;
  return new AppStore(service, { save: () => {} }, loadPreferences(null));
}
const PDC = () => ({ path: "personal.db", blob: new Blob([readFileSync("tests/fixtures/db/pdc-personal-mini.db")]) });
const OFFICIAL = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });

async function opened() {
  const store = makeStore();
  await store.openFiles([OFFICIAL(), PDC()]);
  const book = (title: string) => [...store.books.value.values()].find((b) => b.title === title)!;
  return { store, book };
}

describe("the database's links view of a personal database (external_link)", () => {
  it("lists the links of a book, from the database that has no link table", async () => {
    const { store, book } = await opened();
    store.showBook("source", book("PLACEHOLDER commentary on official").key);
    store.dbLinks.side.value = "source";
    await store.dbLinks.loadSummary(book("PLACEHOLDER commentary on official").key);
    expect(store.dbLinks.summary.value).toMatchObject({ total: 7 });
    await store.dbLinks.loadPage();
    expect(store.dbLinks.list.value!.total).toBe(7);
  });

  it("copy to the project: an internal footnote link is copied as a new link; a 'source' link to the library is refused with the reason", async () => {
    const { store, book } = await opened();
    store.showBook("source", book("PLACEHOLDER base").key);
    store.dbLinks.side.value = "source";
    await store.dbLinks.loadPage();
    const links = store.dbLinks.list.value!.links;
    const footnote = links.find((l) => l.declaredType === "footnotes")!;
    expect(footnote).toBeTruthy();
    const before = store.allLinks.value.length;
    const n = await store.dbLinks.adopt([footnote]);
    expect(n).toBe(1);
    expect(store.allLinks.value).toHaveLength(before + 1);
    expect(store.allLinks.value.at(-1)).toMatchObject({ provenance: "db-copy", status: "new" });

    store.showBook("source", book("PLACEHOLDER commentary on official").key);
    await store.dbLinks.loadPage();
    const toLibrary = store.dbLinks.list.value!.links.find((l) => l.target.book.title === "בראשית")!;
    expect(toLibrary.provenance).toBe("db");
    const count = store.allLinks.value.length;
    expect(await store.dbLinks.adopt([toLibrary])).toBe(0);
    expect(store.allLinks.value).toHaveLength(count); // nothing was added, and the user was told why
    expect(store.notices.value.at(-1)?.kind).toBe("warning");
  });
});
