import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MappedDbSource } from "../../../src/sources/db/mapped-source";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * Issue #42 C4: the links tab of a mapped database (no listing of its own) is built from existingLinks() over the whole
 * book and was kept for every book shown until the database closed — a big mapped database held all of its links.
 * The registry keeps the last few, like DbBookSource keeps its own listings.
 */
const file = { path: "dir/books-lines.db", blob: new Blob([readFileSync("tests/fixtures/db/generic/books-lines.db")]) };

async function mapped() {
  const r = new SourceRegistry();
  const p = (await r.open([file])).needsMapping![0]!;
  const opened = await r.openMapped(p.token, p.guess!);
  // the listing is built from existingLinks(); counted here, so book numbers need not be real books
  const read = vi.spyOn(MappedDbSource.prototype, "existingLinks").mockResolvedValue([]);
  return { r, read, key: (n: number) => `${opened.info.id}:${n}`, id: opened.info.id };
}

afterEach(() => vi.restoreAllMocks());

describe("listings built from existingLinks are bounded (Issue #42 C4)", () => {
  it("keeps the last three books, most recently used first out last", async () => {
    const { r, read, key } = await mapped();
    for (const n of [0, 1, 2]) await r.dbLinkSummary(key(n));
    expect(read).toHaveBeenCalledTimes(3);
    await r.dbLinkSummary(key(0)); // used again: the most recent now
    expect(read).toHaveBeenCalledTimes(3);
    await r.dbLinkSummary(key(3)); // a fourth book: book 1, the least recently used, goes
    await r.dbLinkSummary(key(0));
    await r.dbLinkSummary(key(2));
    expect(read).toHaveBeenCalledTimes(4);
    await r.dbLinkSummary(key(1));
    expect(read).toHaveBeenCalledTimes(5);
    expect(read.mock.calls.map((c) => c[0])).toEqual([key(0), key(1), key(2), key(3), key(1)]);
  });

  it("many books shown one after another never hold more than three listings", async () => {
    const { r, read, key } = await mapped();
    for (let n = 0; n < 50; n++) await r.dbLinkSummary(key(n));
    read.mockClear();
    for (let n = 0; n < 47; n++) await r.dbLinkSummary(key(n));
    expect(read).toHaveBeenCalledTimes(47);
    for (const n of [47, 48, 49]) await r.dbLinkSummary(key(n));
    expect(read).toHaveBeenCalledTimes(50); // 47..49 were evicted by the second pass, not kept by the first
  });

  it("closing the source drops its listings", async () => {
    const { r, read, key, id } = await mapped();
    await r.dbLinkSummary(key(0));
    r.close(id);
    await expect(r.dbLinkSummary(key(0))).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
