import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { diffLines, findMoves } from "../../../src/matching/line-diff";
import { planRelink } from "../../../src/linking/relink";

const OLD: BookRef = { key: "s1:old", title: "ספר", origin: "otzaria" };
const NEW: BookRef = { key: "s2:new", title: "ספר", origin: "otzaria" };
const BASE: BookRef = { key: "s1:base", title: "בסיס", origin: "otzaria" };

const oldLines = Array.from({ length: 10 }, (_, i) => `שורה ${i} של הספר עם מילים ייחודיות מספר ${i}`);
const newLines = ["הקדמה חדשה", ...oldLines];
newLines[5] = newLines[5]!.replace("מילים", "תיבות"); // old line 4 edited
newLines.splice(8, 1); // old line 7 deleted

const mk = (id: string, line: number, over: Partial<Link> = {}): Link => ({
  id, status: "existing", provenance: "file", source: { book: OLD, line }, target: { book: BASE, line: 3 }, declaredType: "source", heRef2: "בסיס ד", keyOrder: ["line_index_1"], ...over,
});

describe("planRelink", () => {
  const mapping = diffLines(oldLines, newLines);
  const plan = planRelink({
    links: [mk("same", 2), mk("edited", 4), mk("gone", 7), mk("other", 1, { source: { book: BASE, line: 1 } }), mk("anch", 4, { anchor: { rawStart: oldLines[4]!.indexOf("הספר"), rawEnd: oldLines[4]!.indexOf("הספר") + 4 } })],
    oldBook: OLD,
    newBook: NEW,
    mapping,
    oldLine: (i) => oldLines[i],
    newLine: (i) => newLines[i],
    isOld: (b) => b.key === OLD.key,
  });
  const byId = new Map(plan.items.map((i) => [i.link.id, i]));

  it("an identical line moves with certainty, to the new book and the shifted line", () => {
    expect(byId.get("same")).toMatchObject({ verdict: "certain", moved: { source: { book: NEW, line: 3 }, status: "edited" } });
  });
  it("an edited line goes to review; a deleted line is lost and never moved", () => {
    expect(byId.get("edited")!.verdict).toBe("review");
    expect(byId.get("gone")).toMatchObject({ verdict: "lost" });
    expect(byId.get("gone")!.moved).toBeUndefined();
  });
  it("links that do not touch the old book are left alone", () => {
    expect(plan.untouched).toBe(1);
    expect(byId.has("other")).toBe(false);
  });
  it("an anchor on an edited line is re-found when its words occur exactly once", () => {
    const a = byId.get("anch")!.moved!.anchor!;
    expect(newLines[5]!.slice(a.rawStart, a.rawEnd)).toBe("הספר");
  });
  it("a re-found anchor drops the old line's contentHash", () => {
    const start = oldLines[4]!.indexOf("הספר");
    const p = planRelink({
      links: [mk("hash", 4, { anchor: { rawStart: start, rawEnd: start + 4, contentHash: "old-line" } })],
      oldBook: OLD, newBook: NEW, mapping, oldLine: (i) => oldLines[i], newLine: (i) => newLines[i], isOld: (b) => b.key === OLD.key,
    });
    const a = p.items[0]!.moved!.anchor!;
    expect(newLines[5]!.slice(a.rawStart, a.rawEnd)).toBe("הספר");
    expect(a.contentHash).toBeUndefined();
  });
});

describe("planRelink: a line moved out of order", () => {
  // old line 1 moved to the end; the monotone alignment leaves it unmatched, findMoves pairs it back
  const old = Array.from({ length: 8 }, (_, i) => `שורה ${i} עם טקסט ייחודי מספר ${i}`);
  const neu = [...old.slice(0, 1), ...old.slice(2), old[1]!];
  const mapping = diffLines(old, neu);
  const moves = findMoves(old, neu, mapping.to);
  const word = old[1]!.indexOf("טקסט");
  const links = [mk("moved", 1, { anchor: { rawStart: word, rawEnd: word + 4 } }), mk("kept", 3)];
  const plan = (withMoves: boolean) =>
    new Map(planRelink({ links, oldBook: OLD, newBook: NEW, mapping, ...(withMoves && { moves }), oldLine: (i) => old[i], newLine: (i) => neu[i], isOld: (b) => b.key === OLD.key }).items.map((i) => [i.link.id, i]));

  it("is carried to its new place for review — never certain (its context changed), never lost", () => {
    expect(mapping.to[1]).toBe(-1);
    const item = plan(true).get("moved")!;
    expect(item.verdict).toBe("review");
    expect(item.moved!.source.line).toBe(7);
    expect(item.reasons.join(" ")).toContain("הועברה");
    // identical text: the anchor travels as is
    expect(neu[7]!.slice(item.moved!.anchor!.rawStart, item.moved!.anchor!.rawEnd)).toBe("טקסט");
    expect(plan(true).get("kept")!.verdict).toBe("certain");
  });
  it("without the moves it is lost, as before", () => {
    expect(plan(false).get("moved")!.verdict).toBe("lost");
  });
});

describe("planRelink: ranges (review C6)", () => {
  // 40 unique lines; `edit` builds the new edition from the old one
  const old = Array.from({ length: 40 }, (_, i) => `שורה ${i} עם טקסט ייחודי מספר ${i}`);
  const run = (neu: string[], ...links: Link[]) => {
    const mapping = diffLines(old, neu);
    const moves = findMoves(old, neu, mapping.to);
    return new Map(planRelink({ links, oldBook: OLD, newBook: NEW, mapping, moves, oldLine: (i) => old[i], newLine: (i) => neu[i], isOld: (b) => b.key === OLD.key }).items.map((i) => [i.link.id, i]));
  };
  const ranged = (id: string, line: number, end: number) => mk(id, 0, { target: { book: OLD, line, end }, source: { book: BASE, line: 1 } });

  it("a range end whose line moved out of order is never carried there: the range is shortened, for review", () => {
    // line 12 moved to the end of the book: findMoves pairs it with 39
    const neu = [...old.slice(0, 12), ...old.slice(13), old[12]!];
    const item = run(neu, ranged("r", 10, 12)).get("r")!;
    expect(item.moved!.target).toMatchObject({ line: 10, end: 11 });
    expect(item.verdict).toBe("review");
    expect(item.reasons.join(" ")).not.toContain("השורה זהה");
  });

  it("an intact range moves with certainty, keeping its length", () => {
    const neu = ["הקדמה חדשה", ...old];
    const item = run(neu, ranged("r", 10, 12)).get("r")!;
    expect(item).toMatchObject({ verdict: "certain", moved: { target: { line: 11, end: 13 } } });
  });

  it("lines inserted, edited, deleted or moved INSIDE a range send it to review", () => {
    const inserted = [...old.slice(0, 11), ...Array.from({ length: 27 }, (_, i) => `שורה חדשה ${i} בתוך הטווח`), ...old.slice(11)];
    const a = run(inserted, ranged("r", 10, 12)).get("r")!;
    expect(a.verdict).toBe("review");
    expect(a.moved!.target).toMatchObject({ line: 10, end: 39 });
    expect(a.reasons.join(" ")).toContain("נוספו");

    const edited = [...old];
    edited[11] = edited[11]!.replace("טקסט", "כתב");
    expect(run(edited, ranged("r", 10, 12)).get("r")!.verdict).toBe("review");

    const deleted = [...old.slice(0, 11), ...old.slice(12)];
    const d = run(deleted, ranged("r", 10, 12)).get("r")!;
    expect(d.verdict).toBe("review");
    expect(d.moved!.target).toMatchObject({ line: 10, end: 11 });

    const movedOut = [...old.slice(0, 11), ...old.slice(12), old[11]!];
    const m = run(movedOut, ranged("r", 10, 12)).get("r")!;
    expect(m.verdict).toBe("review");
    expect(m.moved!.target).toMatchObject({ line: 10, end: 11 });
  });

  it("an edited range end goes to review", () => {
    const neu = [...old];
    neu[12] = neu[12]!.replace("טקסט", "כתב");
    const item = run(neu, ranged("r", 10, 12)).get("r")!;
    expect(item.verdict).toBe("review");
    expect(item.moved!.target).toMatchObject({ line: 10, end: 12 });
  });

  it("a range whose first line moved out of order goes along only as a whole block", () => {
    // lines 10..12 moved together to the end: carried as 37..39, for review
    const block = [...old.slice(0, 10), ...old.slice(13), ...old.slice(10, 13)];
    const b = run(block, ranged("r", 10, 12)).get("r")!;
    expect(b.verdict).toBe("review");
    expect(b.moved!.target).toMatchObject({ line: 37, end: 39 });
    // only line 10 moved: its range is not stretched over what follows it in the new place
    const one = [...old.slice(0, 10), ...old.slice(11), old[10]!];
    const o = run(one, ranged("r", 10, 12)).get("r")!;
    expect(o.verdict).toBe("review");
    expect(o.moved!.target.line).toBe(39);
    expect(o.moved!.target.end).toBeUndefined();
  });
});
