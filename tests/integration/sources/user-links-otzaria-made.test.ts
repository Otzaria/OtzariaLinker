import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Link } from "../../../src/core/links/model";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * V7 PR1 item 10: `user_link` read from a user_books.db that Otzaria ITSELF wrote — not one built from the DDL. The fixture
 * (tests/fixtures/db/README.md) is the user_books.db of an isolated portable copy of Otzaria 0.9.98.3 after the live run 3
 * (docs/reviews/V7_LIVE_OTZARIA_TESTS.md §9): the synthetic books of scripts/live-test, imported by the folder scan and by
 * "ייבוא נתונים", plus the links made in the tool's own UI. Only synthetic titles and headings; no book text.
 *
 * The expected rows below are the table as Python's sqlite3 reads it (scripts/live-test/inspect-user-links.py, read-only), written
 * out by hand: 0-based lines and inclusive ends as stored, raw anchor offsets, the type's name. The tool must list each row that
 * touches a book of this database once, with exactly these values; the one row whose two sides are outside it (41: the library →
 * an attached database) is not listed (a known limitation, QA_V7_PR1.md).
 */
const FIXTURE = "tests/fixtures/db/otzaria-user-books-live.db";
const BYTES = readFileSync(FIXTURE);
const LIBRARY = readFileSync("tests/fixtures/db/seforim-v7-mini.db");

const BASE = "בדיקת מקשר - ספר בסיס";
const CITING = "בדיקת מקשר - ספר מצטט";
const COMM = "בדיקת מקשר - פירוש";
const COMM_GEN = "בדיקת מקשר - פירוש על בראשית";
const NOTES = "הערות לבדיקת מקשר";
const SRC2 = "בדיקת מקשר 2 - מקור";
const TGT2 = "בדיקת מקשר 2 - יעד";
const DBBOOK = "בדיקת מקשר - ספר ממסד אישי";
const GEN = "בראשית";

type Side = [title: string, line: number, end?: number];
interface Row {
  id: number;
  s: Side;
  t: Side;
  type: string;
  anchor?: { rawStart: number; rawEnd?: number; label?: string };
  heRef: string | null;
}
const ROWS: Row[] = [
  { id: 39, s: [DBBOOK, 4], t: [CITING, 1], type: "reference", heRef: `${CITING} 2` },
  { id: 40, s: [DBBOOK, 5], t: [CITING, 5], type: "commentary", heRef: `${CITING} 6` },
  { id: 42, s: [SRC2, 6], t: [TGT2, 39], type: "reference", heRef: `${TGT2} חלק שני` },
  { id: 43, s: [CITING, 6, 7], t: [BASE, 8], type: "reference", heRef: `${BASE} פרק א` },
  { id: 44, s: [CITING, 8], t: [BASE, 10], type: "reference", heRef: `${BASE} פרק ב` },
  { id: 45, s: [CITING, 9], t: [GEN, 2], type: "reference", heRef: "בראשית, א, א" },
  { id: 46, s: [GEN, 1], t: [SRC2, 7], type: "commentary", heRef: null },
  { id: 56, s: [BASE, 2], t: [COMM, 2], type: "commentary", heRef: `${COMM} פרק א` },
  { id: 57, s: [BASE, 3], t: [COMM, 3], type: "commentary", anchor: { rawStart: 47, rawEnd: 51 }, heRef: `${COMM} פרק א` },
  { id: 58, s: [BASE, 4], t: [COMM, 4], type: "commentary", anchor: { rawStart: 54, label: "א" }, heRef: `${COMM} פרק א אות א` },
  { id: 59, s: [BASE, 5], t: [NOTES, 1], type: "footnotes", heRef: `${NOTES} 2` },
  { id: 60, s: [BASE, 6], t: [CITING, 2, 4], type: "reference", heRef: `${CITING} 3` },
  { id: 61, s: [BASE, 7], t: [COMM, 5], type: "commentary", heRef: `${COMM} 6` },
  { id: 62, s: [BASE, 10], t: [COMM, 2], type: "commentary", anchor: { rawStart: 32, rawEnd: 37 }, heRef: `${COMM} פרק א` },
  { id: 63, s: [BASE, 11], t: [CITING, 1], type: "reference", heRef: `${CITING} 2` },
  { id: 64, s: [CITING, 6, 7], t: [BASE, 8], type: "reference", heRef: `${BASE} פרק א` },
  { id: 65, s: [CITING, 8], t: [BASE, 10], type: "reference", heRef: `${BASE} פרק ב` },
  { id: 66, s: [CITING, 9], t: [GEN, 2], type: "reference", heRef: "בראשית, א, א" },
  { id: 67, s: [CITING, 1], t: [GEN, 3, 4], type: "reference", heRef: "בראשית, א, ב" },
  { id: 68, s: [CITING, 2], t: [BASE, 2], type: "reference", anchor: { rawStart: 0, rawEnd: 5 }, heRef: `${BASE}, פרק א` },
  { id: 69, s: [CITING, 3], t: [BASE, 3], type: "reference", anchor: { rawStart: 0, rawEnd: 5 }, heRef: `${BASE}, פרק א` },
  { id: 70, s: [GEN, 3], t: [COMM_GEN, 1], type: "commentary", heRef: null },
  { id: 71, s: [GEN, 4], t: [COMM_GEN, 2], type: "commentary", heRef: `${COMM_GEN} 3` },
  { id: 72, s: [GEN, 5], t: [COMM_GEN, 3], type: "commentary", heRef: `${COMM_GEN} 4` },
  { id: 73, s: [SRC2, 1, 2], t: [TGT2, 4, 6], type: "reference", heRef: `${TGT2} חלק ראשון` },
  { id: 74, s: [SRC2, 3], t: [TGT2, 2], type: "commentary", anchor: { rawStart: 31, rawEnd: 36 }, heRef: `${TGT2} חלק ראשון` },
  { id: 75, s: [SRC2, 3], t: [TGT2, 3], type: "commentary", anchor: { rawStart: 41, rawEnd: 44 }, heRef: `${TGT2} חלק ראשון` },
];
/** the only row with both sides outside user_books.db: בראשית (library) → the attached database's book */
const FOREIGN = 41;

const side = (s: Side) => ({ title: s[0], line: s[1], end: s[2] });

async function open(withLibrary: boolean) {
  const r = new SourceRegistry();
  const files = [{ path: "user_books.db", blob: new Blob([BYTES]) }];
  if (withLibrary) files.unshift({ path: "seforim.db", blob: new Blob([LIBRARY]) });
  const res = await r.open(files);
  const ub = res.sources.find((s) => s.info.label === "user_books.db")!;
  return { r, ub };
}

/** every link the tool lists for the database's books, once each (a link inside the database is listed from both its books) */
async function listed(r: SourceRegistry, keys: string[]): Promise<Map<number, Link>> {
  const out = new Map<number, Link>();
  for (const key of keys) {
    const page = await r.dbLinksPage(key, { offset: 0, limit: 500 });
    for (const l of page.links) out.set(Number(l.id.split(":user:")[1]), l);
  }
  return out;
}

describe("user_link of a user_books.db that Otzaria 0.9.98.3 wrote (live run 3)", () => {
  it("the fixture is the database the live run produced", () => {
    expect(createHash("sha256").update(BYTES).digest("hex")).toBe("d4a188e7ed3d90d4d258c6340e100f1ab0366e47c60c61c7338f3b4307f225db");
  });

  it("each row that touches a book of the database is listed once, with Otzaria's values; the foreign row is not", async () => {
    const { r, ub } = await open(true);
    // the only warning: Otzaria keeps user_books.db in WAL mode (its -wal was empty when the copy was taken)
    expect(ub.info.warnings.map((w) => w.code)).toEqual(["db/wal"]);
    const keys = ub.books.map((b) => b.key);
    const links = await listed(r, keys);
    expect([...links.keys()].sort((a, b) => a - b)).toEqual(ROWS.map((x) => x.id));
    expect(links.has(FOREIGN)).toBe(false);
    for (const row of ROWS) {
      const l = links.get(row.id)!;
      const s = side(row.s);
      const t = side(row.t);
      expect({ id: row.id, s: { title: l.source.book.title, line: l.source.line, end: l.source.end }, t: { title: l.target.book.title, line: l.target.line, end: l.target.end } }).toEqual({ id: row.id, s, t });
      expect({ id: row.id, type: l.declaredType, provenance: l.provenance, table: l.dbTable }).toEqual({ id: row.id, type: row.type, provenance: "db", table: "user_link" });
      expect({ id: row.id, anchor: l.anchor }).toEqual({ id: row.id, anchor: row.anchor });
      if (row.heRef !== null) expect({ id: row.id, heRef: l.heRef2 }).toEqual({ id: row.id, heRef: row.heRef });
    }
  });

  it("with the library open, its side binds to the library's בראשית; the attached database's side stays unresolved", async () => {
    const { r, ub } = await open(true);
    const links = await listed(r, ub.books.map((b) => b.key));
    const genesis = links.get(66)!.target.book;
    expect(genesis.title).toBe(GEN);
    expect(genesis.key.startsWith("unresolved:")).toBe(false);
    expect(genesis.key.startsWith(`${ub.info.id}:`)).toBe(false);
    expect(links.get(39)!.source.book.key).toBe(`unresolved:${DBBOOK}`);
  });

  it("without the library, the library's side is unresolved — never bound to a personal book", async () => {
    const { r, ub } = await open(false);
    const links = await listed(r, ub.books.map((b) => b.key));
    expect(links.get(70)!.source.book).toMatchObject({ key: `unresolved:${GEN}`, title: GEN });
    // the personal side is this database's own book
    expect(links.get(70)!.target.book.key.startsWith(`${ub.info.id}:`)).toBe(true);
  });

  it("the per-book summary counts the rows of each book, out and in", async () => {
    const { r, ub } = await open(true);
    const base = ub.books.find((b) => b.title === BASE)!;
    const s = await r.dbLinkSummary(base.key);
    if (!("total" in s)) throw new Error(`no summary: ${s.reason}`);
    // out: 56–63 (8 rows); in: 43, 44, 64, 65, 68, 69 (6 rows)
    expect(s).toMatchObject({ total: 14, out: 8, in: 6 });
  });
});
