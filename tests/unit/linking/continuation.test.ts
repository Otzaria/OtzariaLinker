import { describe, expect, it } from "vitest";
import type { BookRef, Link, LinkSide } from "../../../src/core/links/model";
import { cancelContinuationEdit, planContinuation, type RangeBook } from "../../../src/linking/ranges";

/*
 * "This passage continues the previous one" (V7 §2.13, issue #44), the pure rule: which links the line
 * before carries, and whether each is extended over the new line or copied to it as its own link.
 */
const A: BookRef = { key: "a", title: "ספר", origin: "personal" };
const B: BookRef = { key: "b", title: "הערות", origin: "personal" };
const C: BookRef = { key: "c", title: "מפרש", origin: "personal" };
let seq = 0;
const link = (src: LinkSide, tgt: LinkSide, extra: Partial<Link> = {}): Link => ({
  id: `l${++seq}`, source: src, target: tgt, declaredType: "commentary", heRef2: "הערות 1", status: "new", provenance: "user", ...extra,
});
const at = (book: BookRef, line: number, end?: number): LinkSide => (end === undefined ? { book, line } : { book, line, end });
const bookOf = (ref: BookRef, lineCount: number, headings: number[] = []): RangeBook => ({ owns: (r) => r.key === ref.key, lineCount, headings: new Set(headings) });
let ids = 0;
const newId = () => `n${++ids}`;

describe("planContinuation (#44)", () => {
  const book = bookOf(A, 20, [0, 10]);

  it("extends the previous line's link over the new line, keeping where it was continued from", () => {
    const prev = link(at(A, 4), at(B, 2));
    const p = planContinuation([prev], book, "source", 5, { newId });
    expect(p.refused).toBeUndefined();
    expect(p.fromLine).toBe(4);
    expect(p.headings).toEqual([]);
    expect(p.items).toHaveLength(1);
    const it0 = p.items[0]!;
    expect(it0.action).toBe("extend");
    expect(it0.after!.id).toBe(prev.id);
    expect(it0.after!.source).toEqual({ book: A, line: 4, end: 5 });
    expect(it0.after!.target).toEqual(prev.target);
    expect(it0.after!.continued).toEqual({ kind: "extend", side: "source", fromLine: 4 });
  });

  it("inherits EVERY link of the previous line (one or several)", () => {
    const l1 = link(at(A, 4), at(B, 2));
    const l2 = link(at(A, 4), at(C, 7), { declaredType: "reference", heRef2: "מפרש 8" });
    const p = planContinuation([l1, l2], book, "source", 5, { newId, mode: "copy" });
    expect(p.items.map((i) => i.action)).toEqual(["copy", "copy"]);
    const copies = p.items.map((i) => i.after!);
    expect(copies.map((c) => [c.source.line, c.target.book.title, c.target.line, c.declaredType, c.heRef2])).toEqual([
      [5, "הערות", 2, "commentary", "הערות 1"],
      [5, "מפרש", 7, "reference", "מפרש 8"],
    ]);
    for (const c of copies) {
      expect(c.status).toBe("new");
      expect(c.provenance).toBe("user");
      expect(c.source.end).toBeUndefined();
    }
    expect(copies[0]!.continued).toEqual({ kind: "copy", side: "source", fromLine: 4, from: l1.id });
  });

  it("the copy never carries the previous line's anchor, its ref_1 or the record's file shape", () => {
    const prev = link(at(A, 4), at(B, 2), { anchor: { rawStart: 3, label: "א" }, ref1: "Genesis 1:4", matched: { source: { rawStart: 3, rawEnd: 6 } }, fileIndex: 7, keyOrder: ["line_index_1"], status: "existing", provenance: "file", ref2: "Notes 3" });
    const [c] = planContinuation([prev], book, "source", 5, { newId, mode: "copy" }).items;
    expect(c!.after!.anchor).toBeUndefined();
    expect(c!.after!.ref1).toBeUndefined();
    expect(c!.after!.matched).toBeUndefined();
    expect(c!.after!.fileIndex).toBeUndefined();
    expect(c!.after!.keyOrder).toBeUndefined();
    expect(c!.after!.ref2).toBe("Notes 3"); // the target did not change
  });

  it("a link that already covers the new line is left alone; no duplicate of an existing link is made", () => {
    const ranged = link(at(A, 3, 6), at(B, 1));
    const prev = link(at(A, 4), at(B, 2));
    const already = link(at(A, 5), at(B, 2), { declaredType: "reference" }); // same two lines, other type
    const p = planContinuation([ranged, prev, already], book, "source", 5, { newId, mode: "copy" });
    expect(p.items.map((i) => [i.prev.id, i.action, i.why])).toEqual([
      [ranged.id, "skip", "covered"],
      [prev.id, "skip", "duplicate"],
    ]);
  });

  it("a link the database already holds is not duplicated either (exists)", () => {
    const prev = link(at(A, 4), at(B, 2));
    const p = planContinuation([prev], book, "source", 5, { newId, mode: "copy", exists: (l) => l.source.line === 5 && l.target.line === 2 });
    expect(p.items[0]!.action).toBe("skip");
    expect(p.items[0]!.why).toBe("duplicate");
  });

  it("two links of the previous line to the same target line make one copy, not two", () => {
    const l1 = link(at(A, 4), at(B, 2));
    const l2 = link(at(A, 3, 4), at(B, 2), { declaredType: "reference" });
    const p = planContinuation([l1, l2], book, "source", 5, { newId, mode: "copy" });
    expect(p.items.filter((i) => i.action === "copy")).toHaveLength(1);
    expect(p.items.filter((i) => i.why === "duplicate")).toHaveLength(1);
  });

  it("when the export refuses a range for that link, an independent link is made instead", () => {
    const prev = link(at(A, 4), at(B, 2));
    const p = planContinuation([prev], book, "source", 5, { newId, rangeRefused: () => "טווח בצד של ספר ספריא" });
    expect(p.items[0]!.action).toBe("copy");
    expect(p.items[0]!.why).toBe("range-refused");
    expect(p.items[0]!.detail).toBe("טווח בצד של ספר ספריא");
    expect(p.items[0]!.after!.id).not.toBe(prev.id);
  });

  it("a database link is never extended (read-only): it is copied", () => {
    const prev = link(at(A, 4), at(B, 2), { provenance: "db", status: "existing" });
    const p = planContinuation([prev], book, "source", 5, { newId });
    expect(p.items[0]!.action).toBe("copy");
  });

  it("finds the previous passage across lines with no link, and reports a heading between them", () => {
    const prev = link(at(A, 7), at(B, 2));
    const p = planContinuation([prev], book, "source", 12, { newId });
    expect(p.fromLine).toBe(7);
    expect(p.headings).toEqual([10]);
  });

  it("the end of a ranged previous link is the previous passage", () => {
    const prev = link(at(A, 1, 3), at(B, 2));
    const p = planContinuation([prev], book, "source", 4, { newId });
    expect(p.fromLine).toBe(3);
    expect(p.items[0]!.after!.source).toEqual({ book: A, line: 1, end: 4 });
    expect(p.items[0]!.after!.continued).toEqual({ kind: "extend", side: "source", fromLine: 3, baseEnd: 3 });
  });

  it("refuses a heading line and a line with nothing before it", () => {
    expect(planContinuation([link(at(A, 4), at(B, 2))], book, "source", 10, { newId }).refused).toBe("heading-line");
    expect(planContinuation([link(at(A, 4), at(B, 2))], book, "source", 3, { newId }).refused).toBe("no-previous");
    expect(planContinuation([link(at(A, 4), at(B, 2), { status: "deleted" })], book, "source", 5, { newId }).refused).toBe("no-previous");
  });

  it("works on the target side too: the passage book is the link's target", () => {
    const prev = link(at(B, 2), at(A, 4));
    const p = planContinuation([prev], book, "target", 5, { newId, mode: "copy", heRef2: (line) => `ספר ${line + 1}` });
    const c = p.items[0]!.after!;
    expect(c.target).toEqual({ book: A, line: 5 });
    expect(c.source).toEqual(prev.source);
    expect(c.heRef2).toBe("ספר 6");
  });

  it("a second continuation keeps the end the link had before the first one", () => {
    const prev = link(at(A, 4), at(B, 2));
    const once = planContinuation([prev], book, "source", 5, { newId }).items[0]!.after!;
    const twice = planContinuation([once], book, "source", 6, { newId }).items[0]!.after!;
    expect(twice.source).toEqual({ book: A, line: 4, end: 6 });
    expect(twice.continued).toEqual({ kind: "extend", side: "source", fromLine: 4 });
  });
});

describe("cancelContinuationEdit (#44)", () => {
  it("an extended link goes back to the range it had, and an untouched library record to 'existing'", () => {
    const prev = link(at(A, 1, 3), at(B, 2), { status: "existing", provenance: "file" });
    const ext = planContinuation([prev], bookOf(A, 20), "source", 4, { newId }).items[0]!.after!;
    expect(ext.status).toBe("edited");
    const back = cancelContinuationEdit(ext);
    expect(back).toEqual(prev);
  });

  it("an extended single-line link loses the range", () => {
    const prev = link(at(A, 4), at(B, 2));
    const ext = planContinuation([prev], bookOf(A, 20), "source", 5, { newId }).items[0]!.after!;
    expect(cancelContinuationEdit(ext)).toEqual(prev);
  });

  it("a copied link is removed (null); a link with no continuation is not touched (undefined)", () => {
    const prev = link(at(A, 4), at(B, 2));
    const copy = planContinuation([prev], bookOf(A, 20), "source", 5, { newId, mode: "copy" }).items[0]!.after!;
    expect(cancelContinuationEdit(copy)).toBeNull();
    expect(cancelContinuationEdit(prev)).toBeUndefined();
  });
});
