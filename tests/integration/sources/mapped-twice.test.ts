import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MappedDbSource } from "../../../src/sources/db/mapped-source";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * Fix round before merge (task 4e): a database opened through the mapping wizard is one source too (#22 covered Otzaria's
 * own schema only; QA_V6_PR1 listed "a mapped database gets no identity" as a known limit). Picking the same file again must
 * not offer a second wizard or open a second reader; the same mapping asked twice is the same reader; another mapping
 * REPLACES the first reader (one reader per file, the store's re-map closes the old one first anyway); closing frees the file.
 */
const bytes = readFileSync("tests/fixtures/db/generic/books-lines.db");
const file = (name = "books-lines.db", path = `dir/${name}`) => ({ path, blob: new Blob([bytes]) });

async function pending(r: SourceRegistry) {
  const res = await r.open([file()]);
  expect(res.needsMapping).toHaveLength(1);
  return res.needsMapping![0]!;
}

describe("a mapped database is one source", () => {
  it("picked again after it was mapped, it is reported as open and not offered for mapping again", async () => {
    const r = new SourceRegistry();
    const p = await pending(r);
    const opened = await r.openMapped(p.token, p.guess!);
    const again = await r.open([file()]);
    expect(again.needsMapping).toBeUndefined();
    expect(again.skipped).toEqual([]);
    expect(again.reused!.map((x) => x.info.id)).toEqual([opened.info.id]);
  });

  it("the same mapping asked twice (two wizards of one file) opens one reader", async () => {
    const open = vi.spyOn(MappedDbSource, "open");
    try {
      const r = new SourceRegistry();
      const a = await pending(r);
      const b = await pending(r); // the same file offered twice before it was mapped: two tokens
      expect(b.token).not.toBe(a.token);
      const first = await r.openMapped(a.token, a.guess!);
      const second = await r.openMapped(b.token, a.guess!);
      expect(second.info.id).toBe(first.info.id);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it("another mapping of an open file replaces its reader: one reader per file", async () => {
    const r = new SourceRegistry();
    const p = await pending(r);
    const first = await r.openMapped(p.token, p.guess!);
    const second = await r.openMapped(p.token, { ...p.guess!, links: undefined } as never);
    expect(second.info.id).not.toBe(first.info.id);
    await expect(r.lines(first.books[0]!.key, 0, 1)).rejects.toThrow(); // the old reader is gone
    expect((await r.lines(second.books[0]!.key, 0, 1))[0]!.text).toBe("ספר הדוגמה");
  });

  it("closing the source frees the file: it can be picked and mapped again", async () => {
    const r = new SourceRegistry();
    const p = await pending(r);
    const first = await r.openMapped(p.token, p.guess!);
    r.close(first.info.id);
    const again = await r.open([file()]);
    expect(again.reused).toBeUndefined();
    expect(again.needsMapping).toHaveLength(1);
    expect((await r.openMapped(again.needsMapping![0]!.token, p.guess!)).info.id).not.toBe(first.info.id);
  });

  it("a file of the same name but another size is another database", async () => {
    const r = new SourceRegistry();
    const p = await pending(r);
    await r.openMapped(p.token, p.guess!);
    const other = await r.open([{ path: "dir/books-lines.db", blob: new Blob([bytes, new Uint8Array(4096)]) }]);
    expect(other.reused).toBeUndefined();
  });
});
