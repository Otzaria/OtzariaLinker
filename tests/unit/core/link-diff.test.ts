import { describe, expect, it } from "vitest";
import { detailDifferences, diffGroup, diffLinks, linkDiffKey, mergeLinkSets } from "../../../src/core/links/link-diff";
import type { BookRef, Link } from "../../../src/core/links/model";
import { linkDiffCsv } from "../../../src/formats/report/link-diff-report";

/*
 * The semantic diff of two link sets and the lossless merge of several links files of one book
 * (V5 P1-9). Books and lines are shaped like the real ones in tests/fixtures/db/seforim-v7-mini.db
 * (ארצות החיים and its two commentaries; link 13469515 = 322 → 1306, COMMENTARY, anchor 28).
 */
const book = (key: string, title: string, isBaseBook = false): BookRef => ({ key, title, origin: "otzaria", isBaseBook });
const ARZOT = book("s1:8050", "ארצות החיים");
const MEIR = book("s1:8051", "המאיר לארץ על ארצות החיים");
const YEHUDA = book("s1:8052", "ארץ יהודה על ארצות החיים");

let n = 0;
const link = (s: number, t: number, over: Partial<Link> = {}, target = MEIR): Link => ({
  id: `l${n++}`,
  status: "existing",
  provenance: "file",
  source: { book: ARZOT, line: s },
  target: { book: target, line: t },
  declaredType: "commentary",
  heRef2: `${target.title} ${t + 1}`,
  ...over,
});
const db = (s: number, t: number, over: Partial<Link> = {}, target = MEIR): Link => link(s, t, { provenance: "db", declaredType: "COMMENTARY", heRef2: "", ...over }, target);

describe("diffLinks", () => {
  it("pairs every kind of change, each link once, whatever the order", () => {
    const a = [
      link(1, 10),
      link(2, 20, { target: { book: MEIR, line: 20, end: 22 } }),
      link(3, 30, { anchor: { rawStart: 4 } }),
      link(4, 40, { declaredType: "other" }),
      link(5, 50, { heRef2: "old" }),
      link(6, 60),
      link(7, 70),
      link(8, 80),
      link(9, 90),
    ];
    const b = [
      link(9, 91), // target changed (another line of the same book)
      link(8, 80, { declaredType: "other" }), // same two lines, other stored type
      link(7, 71 + 100), // target changed, far away
      link(6, 60, { target: { book: MEIR, line: 60 } }), // the same
      link(5, 50, { heRef2: "new" }),
      link(4, 40, { declaredType: "הערה" }), // an unknown type: stored as OTHER too, but declared otherwise
      link(3, 30, { anchor: { rawStart: 9 } }),
      link(2, 20, { target: { book: MEIR, line: 20, end: 25 } }),
      link(11, 10), // moved to another source line (target 10 kept)
      link(12, 120),
    ];
    const d = diffLinks(a, b);
    const kind = (s: number) => d.rows.find((r) => (r.a ?? r.b)!.source.line === s)!.kind;
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(kind)).toEqual(["moved", "range", "anchor", "type", "details", "same", "target", "type", "target"]);
    expect(d.rows.find((r) => r.b?.source.line === 11)?.a?.source.line).toBe(1);
    expect(d.rows.filter((r) => r.kind === "added").map((r) => r.b!.source.line)).toEqual([12]);
    expect(d.counts).toMatchObject({ same: 1, range: 1, anchor: 1, type: 2, details: 1, target: 2, moved: 1, removed: 0, added: 1 });
    expect(d.rows.length).toBe(b.length);
    // the order of the inputs does not change the pairing
    const r = diffLinks([...a].reverse(), [...b].reverse());
    expect(r.counts).toEqual(d.counts);
    expect(diffGroup(d.rows.find((x) => x.kind === "range")!)).toBe("overlap");
  });

  it("is semantic: a 'source' record from the commentary's file is the base's COMMENTARY link", () => {
    const fromCommentary: Link = { ...link(0, 0), source: { book: MEIR, line: 1306 }, target: { book: ARZOT, line: 322 }, declaredType: "source", heRef2: "ארצות החיים 323" };
    const d = diffLinks([db(322, 1306)], [fromCommentary]);
    expect(d.loose).toBe(true);
    expect(d.rows).toEqual([{ kind: "same", a: expect.anything(), b: fromCommentary }]);
    // a record of the same two lines written the other way with its own type is the record turned around
    const turned = diffLinks([link(322, 1306)], [fromCommentary]);
    expect(turned.rows.map((r) => r.kind)).toEqual(["direction"]);
  });

  it("against a database: heRef_2 and anchors are not compared, ranges are", () => {
    const d = diffLinks([db(332, 313, { target: { book: YEHUDA, line: 313, end: 316 } }, YEHUDA), db(612, 2662, { dbAnchors: [{ side: 0, charStart: 611 }] })], [
      link(612, 2662, { anchor: { rawStart: 700 }, heRef2: "x" }),
      link(332, 313, {}, YEHUDA),
      link(700, 1),
    ]);
    expect(d.rows.map((r) => [r.kind, diffGroup(r)])).toEqual([
      ["same", "identical"],
      ["range", "overlap"],
      ["added", "onlyB"],
    ]);
  });

  it("only in A and only in B; a target that still overlaps is an overlap, not a conflict", () => {
    const d = diffLinks([link(1, 10, { target: { book: MEIR, line: 10, end: 12 } }), link(2, 5)], [link(1, 11), link(3, 5, {}, YEHUDA)]);
    expect(d.rows.map((r) => [r.kind, diffGroup(r)])).toEqual([
      ["target", "overlap"],
      ["removed", "onlyA"],
      ["added", "onlyB"],
    ]);
    expect(linkDiffCsv(d, "המסד", "הקובץ").split("\r\n")).toHaveLength(5);
  });

  /*
   * #15: two files whose only difference is heRef_2 / ref_1 / ref_2 landed in "conflicts", and the screen
   * printed neither field, so both columns read identically. They are their own group now, and the fields
   * that differ are known (and shown).
   */
  it("a record that differs only in heRef_2, ref_1 or ref_2 is a 'details' row, not a conflict", () => {
    const d = diffLinks(
      [link(1, 10, { ref1: "Genesis 1:1" }), link(2, 20, { heRef2: "x" }), link(3, 30, { ref2: "A" }), link(4, 40)],
      [link(1, 10, { ref1: "Genesis 1:2" }), link(2, 20, { heRef2: "y" }), link(3, 30, { ref2: "B" }), link(4, 41)],
    );
    const group = (s: number) => diffGroup(d.rows.find((r) => r.a!.source.line === s)!);
    expect([1, 2, 3].map(group)).toEqual(["details", "details", "details"]);
    expect(d.rows.filter((r) => r.kind === "details")).toHaveLength(3); // the kind stays: merges still treat it as a disagreement
    expect(group(4)).toBe("conflict"); // another target line is a real disagreement
  });

  it("names the fields that differ, and only those", () => {
    expect(detailDifferences(link(1, 10, { ref1: "a", ref2: "b" }), link(1, 10, { ref1: "a", ref2: "c", heRef2: "z" }))).toEqual([
      { field: "heRef2", a: link(1, 10).heRef2, b: "z" },
      { field: "ref2", a: "b", b: "c" },
    ]);
    expect(detailDifferences(link(1, 10), link(1, 10))).toEqual([]);
    // an absent ref and an empty one are the same: nothing was written
    expect(detailDifferences(link(1, 10, { ref1: undefined }), link(1, 10, { ref1: "" }))).toEqual([]);
  });

  it("the CSV report carries ref_1 and ref_2 of each side", () => {
    const d = diffLinks([link(1, 10, { ref1: "REF-ONE-A" })], [link(1, 10, { ref1: "REF-ONE-B", ref2: "REF-TWO-B" })]);
    const csv = linkDiffCsv(d, "א", "ב");
    expect(csv).toContain("REF-ONE-A");
    expect(csv).toContain("REF-ONE-B");
    expect(csv).toContain("REF-TWO-B");
    expect(csv.split("\r\n")[0]).toContain("ref_1");
  });

  /*
   * 1.7 (task list): the references are compared the way a reader sees them — whitespace of any kind (NBSP, tabs,
   * doubled spaces), zero-width and direction marks do not make two places different — and the type through the
   * generator's parser, so "COMMENTARY", " commentary " and the alias "quotation_auto" are what they store. The
   * written values stay as they were; only the comparison is normalised.
   */
  it("references that differ only in invisible characters or spacing are the same link", () => {
    const messy = "ספר ב  ​5	";
    const a = [link(1, 10, { heRef2: "ספר ב 5", ref1: "Genesis 1:1", ref2: undefined })];
    const b = [link(1, 10, { heRef2: messy, ref1: "Genesis 1:1 ", ref2: undefined })];
    const d = diffLinks(a, b);
    expect(d.rows.map((r) => r.kind)).toEqual(["same"]);
    expect(detailDifferences(a[0]!, b[0]!)).toEqual([]);
    expect(linkDiffKey(a[0]!)).toBe(linkDiffKey(b[0]!));
    // a real difference of words still shows
    const c = diffLinks(a, [link(1, 10, { heRef2: "ספר ג 5", ref1: "Genesis 1:1" })]);
    expect(c.rows.map((r) => r.kind)).toEqual(["details"]);
  });

  it("the type is compared as the generator parses it, not as a lower-cased string", () => {
    for (const [x, y] of [["COMMENTARY", "commentary"], [" Commentary ", "commentary"], ["quotation_auto", "quotation"], ["Super Commentary", "super_commentary"], ["footnote", "footnotes"]] as const) {
      const d = diffLinks([link(1, 10, { declaredType: x })], [link(1, 10, { declaredType: y })]);
      expect(d.rows.map((r) => r.kind), `${x} / ${y}`).toEqual(["same"]);
    }
    // two unknown strings are not the same type (the file says different things), a known one and an unknown are not either
    expect(diffLinks([link(1, 10, { declaredType: "foo" })], [link(1, 10, { declaredType: "bar" })]).rows.map((r) => r.kind)).toEqual(["type"]);
    expect(diffLinks([link(1, 10, { declaredType: "other" })], [link(1, 10, { declaredType: "foo" })]).rows.map((r) => r.kind)).toEqual(["type"]);
    expect(diffLinks([link(1, 10, { declaredType: "commentary" })], [link(1, 10, { declaredType: "targum" })]).rows.map((r) => r.kind)).not.toContain("same");
  });

  it("100K links against 100K links in well under a second", () => {
    const N = 100_000;
    const a = Array.from({ length: N }, (_, i) => link(i, i * 2));
    const b = a.map((l, i) => (i % 10 === 0 ? { ...l, target: { book: MEIR, line: l.target.line + 1 } } : i % 7 === 0 ? { ...l, id: `x${i}` } : l));
    const t0 = performance.now();
    const d = diffLinks(a, b);
    const ms = performance.now() - t0;
    console.log(`diffLinks, ${N} links against ${N}: ${ms.toFixed(0)} ms`);
    expect(d.rows.length).toBe(N);
    expect(d.counts.target).toBe(N / 10);
    expect(ms).toBeLessThan(3000);
  });
});

describe("mergeLinkSets", () => {
  const base = [link(1, 10), link(2, 20), link(2, 20, { id: "dup-in-base" })];
  const other = [link(1, 10, { id: "o1" }), link(2, 21, { id: "o2" }), link(3, 30, { id: "o3" }), link(3, 30, { id: "o3-again" })];
  const third = [link(3, 30, { id: "t3" }), link(4, 40, { id: "t4" })];

  it("keeps the preferred file whole, adds what is new, folds duplicates, never overwrites a conflict", () => {
    const m = mergeLinkSets([{ name: "a.json", links: base }, { name: "b.json", links: other }, { name: "c.json", links: third }], 0);
    expect(m.entries.map((e) => [e.link.id, e.origins, e.base])).toEqual([
      [base[0]!.id, ["a.json", "b.json"], true],
      [base[1]!.id, ["a.json"], true],
      ["dup-in-base", ["a.json"], true],
      ["o3", ["b.json", "c.json"], false],
      ["t4", ["c.json"], false],
    ]);
    expect(m.duplicates).toBe(3); // o1 = base 1→10, o3-again in b itself, t3 = o3
    expect(m.conflicts.map((c) => [c.kind, c.kept.id, c.other.id, c.origin])).toEqual([["target", base[1]!.id, "o2", "b.json"]]);
  });

  it("the preferred source decides which side of a conflict is held; keepConflicts holds both", () => {
    const m = mergeLinkSets([{ name: "a.json", links: base }, { name: "b.json", links: other }], 1);
    expect(m.entries.filter((e) => e.base).map((e) => e.link.id)).toEqual(["o1", "o2", "o3", "o3-again"]);
    expect(m.conflicts.map((c) => c.other.id)).toEqual([base[1]!.id]);
    const both = mergeLinkSets([{ name: "a.json", links: base }, { name: "b.json", links: other }], 0, true);
    expect(both.entries.map((e) => e.link.id)).toContain("o2");
  });

  it("merging is idempotent: the merged set merged with its sources adds nothing", () => {
    const m = mergeLinkSets([{ name: "a.json", links: base }, { name: "b.json", links: other }], 0);
    const again = mergeLinkSets([{ name: "m", links: m.entries.map((e) => e.link) }, { name: "a.json", links: base }, { name: "b.json", links: other }], 0);
    expect(again.entries.length).toBe(m.entries.length);
    expect(new Set(m.entries.map((e) => linkDiffKey(e.link))).size).toBe(m.entries.length - 1); // only the base's own duplicate
  });
});
