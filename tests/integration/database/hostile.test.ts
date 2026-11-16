import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LineContentCodec } from "../../../src/database/compression/zstd";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { decodeRecord } from "../../../src/database/sqlite/lazy/record";
import { DbBookSource } from "../../../src/sources/db/db-source";

/* Regression tests for the security review (2026-11-11): hostile inputs must fail fast and clearly. */
const open = (f: string) => DbBookSource.open("h", f, bytesSource(new Uint8Array(readFileSync(`tests/fixtures/db/hostile/${f}`))));

/** A zstd frame of RLE blocks declaring `fcs` bytes of content (tiny input, huge output). */
function rleFrame(fcs: number): number[] {
  const out = [0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x38, fcs & 255, (fcs >> 8) & 255, (fcs >> 16) & 255, (fcs >>> 24) & 255];
  for (let left = fcs; left > 0; ) {
    const sz = Math.min(131072, left);
    left -= sz;
    const h = (sz << 3) | (1 << 1) | (left === 0 ? 1 : 0);
    out.push(h & 255, (h >> 8) & 255, (h >> 16) & 255, 0x41);
  }
  return out;
}

describe("hostile databases fail fast", () => {
  it("a b-tree that points back at itself is reported as corrupt, not walked forever", async () => {
    await expect(open("cycle.db")).rejects.toThrow(/פגום|מעגל/);
  }, 10_000);

  it("an unterminated [ in a table's SQL does not loop forever", async () => {
    // its line table parses to one odd column, so it is not an Otzaria database (it goes to the mapping wizard)
    await expect(open("bracket.db")).rejects.toMatchObject({ code: "db/no-books" });
  }, 10_000);

  it("a record whose header claims to be larger than the record is rejected", () => {
    expect(() => decodeRecord(new Uint8Array([0x81, 0x80, 0x80, 0x80, 0x00]), 1)).toThrow(expect.objectContaining({ code: "db/corrupt" }));
  });

  it("concatenated zstd frames cannot expand a small value into gigabytes", () => {
    const one = rleFrame(10_000_000);
    const bomb = new Uint8Array(Array.from({ length: 300 }, () => one).flat());
    expect(() => new LineContentCodec([]).decode(bomb)).toThrow(expect.objectContaining({ code: "db/compressed-corrupt" }));
    const smaller = rleFrame(1_000_000);
    const many = new Uint8Array(Array.from({ length: 300 }, () => smaller).flat());
    const t0 = Date.now();
    let len = 0;
    try {
      len = new LineContentCodec([]).decode(many)!.length;
    } catch {
      /* rejecting is fine too */
    }
    expect(len).toBeLessThanOrEqual(1_000_000);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
