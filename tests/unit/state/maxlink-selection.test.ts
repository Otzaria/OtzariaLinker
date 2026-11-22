import { signal } from "@preact/signals";
import { describe, expect, it } from "vitest";
import { MaxLinkState } from "../../../src/state/maxlink";

/* `selection({kind:"books"})`: the books the user ticked that are open, each once, in the order given — and without a quadratic scan. */
function state(open: string[]) {
  const host = { books: signal(new Map(open.map((k) => [k, { key: k }]))), sources: signal([]) };
  return new MaxLinkState(host as never, {} as never, {} as never);
}

describe("MaxLinkState.selection for chosen books", () => {
  it("keeps the order, drops duplicates and books that are not open", () => {
    const s = state(["a", "b", "c"]);
    expect(s.selection({ kind: "books", keys: ["c", "x", "a", "c", "b", "a"] })).toEqual(["c", "a", "b"]);
    expect(s.selection({ kind: "books", keys: [] })).toEqual([]);
  });

  it("a long list is a linear scan (20,000 keys took ~250ms with indexOf inside filter, a few ms with a Set)", () => {
    const keys = Array.from({ length: 20_000 }, (_, i) => `src:${i}`);
    const s = state(keys);
    const t = performance.now();
    const out = s.selection({ kind: "books", keys });
    const ms = performance.now() - t;
    expect(out).toHaveLength(20_000);
    expect(ms).toBeLessThan(100);
  });
});
