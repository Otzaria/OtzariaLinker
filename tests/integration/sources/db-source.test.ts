import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { storedForm } from "../../../src/core/links/stored-form";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { DbBookSource } from "../../../src/sources/db/db-source";

let src: DbBookSource;
beforeAll(async () => {
  src = await DbBookSource.open("db1", "seforim mini", bytesSource(new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"))));
});

describe("DbBookSource on a real schema-7 slice", () => {
  it("books carry origin and base-book flag", async () => {
    const b = (await src.books()).find((x) => x.title === "בראשית")!;
    expect(b).toMatchObject({ key: "db1:1", origin: "sefaria", isBaseBook: true, sourceName: "Sefaria" });
  });
  it("books carry the base books the database declares (book_base_text) and dependenceType", async () => {
    const books = await src.books();
    const of = (t: string) => books.find((x) => x.title === t)!;
    expect(of('רש"י על בראשית')).toMatchObject({ bases: ["db1:1"], dependence: "commentary" });
    expect(of("תרגום אונקלוס על בראשית")).toMatchObject({ bases: ["db1:1"], dependence: "targum" });
    // משנה ברורה is declared on שולחן ערוך (id 382), which is not in this slice: kept, so the planner can say so
    expect(of("משנה ברורה")).toMatchObject({ bases: ["db1:382"], dependence: "commentary" });
    expect(of("בראשית").bases).toBeUndefined();
  });
  it("lines carry heading level and the generator's anchor text", async () => {
    const [first] = await src.lines("db1:1", 0, 0);
    expect(first).toMatchObject({ index: 0, text: "<h1>בראשית</h1>", heading: 1, existsInDb: true });
  });
  it("existing links are read-only db links in the stored direction, and their stored form is themselves", async () => {
    const links = await src.existingLinks("db1:1", 0, 30);
    expect(links.length).toBeGreaterThan(20);
    for (const l of links) {
      expect(l).toMatchObject({ provenance: "db", status: "existing" });
      expect(l.heRef2.length).toBeGreaterThan(0);
      const f = storedForm(l);
      if (!f.skipped && !f.uncertain) expect(f.flipped || f.downgraded).toBe(false);
    }
  });
});
