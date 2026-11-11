import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { diffLines } from "../../../src/matching/line-diff";
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
});
