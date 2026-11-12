import { describe, expect, it } from "vitest";
import { MAX_ALT_TOC_DEPTH, nodesToEntries, rowsToEntries, validateAltToc, type AltTocNode } from "../../../src/core/alt-toc/model";
import { planAltTocExport } from "../../../src/formats/alt-toc/export";
import { parseAltTocJson } from "../../../src/formats/alt-toc/file";

/* Security review A7: a structure nested thousands of levels deep must not throw RangeError. */
const deepFile = (d: number) => '[{"key":"k","nodes":[' + '{"heTitle":"a","line":1,"children":['.repeat(d) + "]}".repeat(d) + "]}]";

describe("alt_toc nested deeper than any real structure", () => {
  it("a deep file is read without overflowing, cut at the limit and reported", () => {
    for (const d of [5_000, 20_000]) {
      const r = parseAltTocJson(deepFile(d));
      expect(r.generatorRejectsFile).toBe(true);
      expect(r.issues.filter((i) => i.code === "alt-toc/too-deep")).toHaveLength(1);
      expect(r.structures[0]!.entries).toHaveLength(MAX_ALT_TOC_DEPTH);
    }
    expect(parseAltTocJson(deepFile(10)).issues).toEqual([]);
  });

  it("the walkers are iterative", () => {
    let root: AltTocNode = { heTitle: "a", line: 1 };
    for (let i = 0; i < 100_000; i++) root = { heTitle: "a", line: 1, children: [root] };
    expect(nodesToEntries([root])).toHaveLength(100_001);
    const chain = Array.from({ length: 100_000 }, (_, i) => ({ id: i + 1, parentId: i === 0 ? null : i, line: 1, text: "a" }));
    const { entries } = rowsToEntries(chain);
    expect(entries).toHaveLength(100_000);
    expect(entries.at(-1)!.level).toBe(99_999);
  });

  it("a too-deep structure is an error, and its book is held back instead of throwing in JSON.stringify", () => {
    const entries = Array.from({ length: 20_000 }, (_, i) => ({ heTitle: "a", line: 1, level: i }));
    expect(validateAltToc([{ key: "k", heTitle: "x", entries }]).some((p) => p.code === "alt-toc/too-deep" && p.severity === "error")).toBe(true);
    const plan = planAltTocExport([{ title: "ספר", origin: "user", structures: [{ key: "k", heTitle: "x", entries }] } as never], () => ({}));
    expect(plan.files).toEqual([]);
    expect(plan.heldBack).toHaveLength(1);
  });

  it("40,000 siblings from a database are grouped in linear time (security review A8)", () => {
    const t = performance.now();
    expect(rowsToEntries(Array.from({ length: 40_000 }, (_, i) => ({ id: i + 1, parentId: null, line: 1, text: "a" }))).entries).toHaveLength(40_000);
    expect(performance.now() - t).toBeLessThan(2_000);
  });
});
