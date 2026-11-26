import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";
import { loadSqlJs } from "../../support/sql-js";

/*
 * Issue #41 B20 (V7 spec §1.4), the state's side: a book of user_books.db whose personal links (user_link) are read is counted with
 * them; a book whose user_link CANNOT be read is never reported as "0 links" or "100% unlinked" — coverage says unknown and why,
 * the links panel's totals leave it out, the repository row says it is unavailable. Real DDL (tests/fixtures/schemas/user-books.sql,
 * database.dart @ a6be90800); placeholder rows. Book A has lines here so that its coverage can be counted at all.
 */
const USER_BOOKS = readFileSync("tests/fixtures/schemas/user-books.sql", "utf8");
const AT = USER_BOOKS.indexOf("CREATE TABLE IF NOT EXISTS user_link");
/** the real user_link without targetIsUserBook: a layout the reader does not know */
const BROKEN = USER_BOOKS.slice(0, AT) + USER_BOOKS.slice(AT).replace(/\n\s*targetIsUserBook INTEGER NOT NULL DEFAULT 0,/, "").replace(/CREATE INDEX[^\n]*targetIsUserBook[^\n]*\n/, "");

async function userBooks(ddl: string): Promise<{ path: string; blob: Blob }> {
  const SQL = await loadSqlJs();
  const d = new SQL.Database();
  d.exec(ddl);
  d.exec("INSERT INTO source(id, name) VALUES (1, 'PLACEHOLDER source'); INSERT INTO category(id, title) VALUES (1, 'PLACEHOLDER category');");
  d.exec("INSERT INTO book(id, categoryId, sourceId, title, totalLines, isPersonal) VALUES (1, 1, 1, 'PLACEHOLDER personal A', 4, 1), (2, 1, 1, 'PLACEHOLDER personal B', 4, 1);");
  for (const b of [1, 2]) for (let i = 0; i < 4; i++) d.run("INSERT INTO line(id, bookId, lineIndex, content) VALUES (?, ?, ?, ?)", [b * 100 + i, b, i, `שורה עם אותיות ${i}`]);
  if (ddl === USER_BOOKS)
    d.exec(`INSERT INTO user_link (sourceTitle, sourceIsUserBook, sourceLineIndex, targetTitle, targetIsUserBook, targetLineIndex, connectionType) VALUES
            ('PLACEHOLDER personal A', 1, 0, 'PLACEHOLDER personal B', 1, 0, 'COMMENTARY'),
            ('PLACEHOLDER personal A', 1, 2, 'PLACEHOLDER personal B', 1, 3, 'REFERENCE');`);
  const bytes = d.export();
  d.close();
  return { path: "user_books.db", blob: new Blob([bytes as BlobPart]) };
}

async function opened(ddl: string) {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
  await store.openFiles([await userBooks(ddl)]);
  const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
  return { store, a: key("PLACEHOLDER personal A") };
}

describe("user_link in the state: counted when read, never 0 when not", () => {
  it("a readable user_link is counted by coverage and by the links panel's totals", async () => {
    const { store, a } = await opened(USER_BOOKS);
    const s = (await store.coverage.summary(a))!;
    expect(s.links).toEqual({ state: "counted", count: 2 });
    expect(s.byBucket.linked).toBe(2);
    expect((await store.dbLinks.totalsOf([a])).get(a)).toBe(2);
  });

  it("an unreadable user_link: coverage is unknown and says why, and nothing is saved as the book's coverage", async () => {
    const { store, a } = await opened(BROKEN);
    expect(store.books.value.get(a)?.linksUnread).toMatch(/user_link/);
    const s = (await store.coverage.summary(a))!;
    expect(s.links).toMatchObject({ state: "unknown", why: "unreadable" });
    expect(s.links.state === "unknown" && s.links.why === "unreadable" && s.links.message).toMatch(/user_link/);
    expect(store.coverage.snapshot()).toEqual([]);
    const [row] = await store.coverage.table([a]);
    expect(row!.links).toMatchObject({ state: "unknown", why: "unreadable" });
  });

  it("an unreadable user_link: the panel's totals leave the book out, and the repository row says it is unavailable", async () => {
    const { store, a } = await opened(BROKEN);
    expect((await store.dbLinks.totalsOf([a])).has(a)).toBe(false);
    await store.repository.analyze();
    const row = store.repository.rows.value.get(a)!;
    expect(row.unavailable).toMatch(/user_link/);
    expect(store.repository.totals.value.noLinks).toBe(0);
  });
});
