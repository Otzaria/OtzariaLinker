import { describe, expect, it } from "vitest";
import { APP_DEPENDENT_TYPES, appPanelOf, AUTHORABLE_TYPES, CONNECTION_TYPES, TYPE_LABELS, typeGroups, type ConnectionType } from "../../../src/core/links/connection-type";

/*
 * Issue 26a: the type picker is grouped the way Otzaria shows the links — "commentaries" (dependent-text types: the
 * commentary panel) and "links" (the links panel) — instead of one flat list. The grouping is derived from
 * appPanelOf, not written a second time.
 */
describe("typeGroups", () => {
  const g = typeGroups();
  const all = [...g.commentaries, ...g.links, ...g.direction];

  it("puts every authorable type in exactly one group, and LINKER in none", () => {
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...AUTHORABLE_TYPES].sort());
    expect(all).not.toContain("LINKER");
  });

  it("agrees with where Otzaria shows a stored link (appPanelOf)", () => {
    for (const t of g.commentaries) expect(appPanelOf(t), t).toBe("commentaries");
    for (const t of g.links) expect(appPanelOf(t), t).toBe("links");
    expect([...g.commentaries].sort()).toEqual([...APP_DEPENDENT_TYPES].sort());
  });

  it("commentary and footnotes are commentaries; reference and quotation are links; SOURCE is a direction of its own", () => {
    for (const t of ["COMMENTARY", "SUPER_COMMENTARY", "TARGUM", "MIDRASH", "DIBUR_HAMATCHIL", "FOOTNOTES", "EXPLICATION"] as ConnectionType[]) expect(g.commentaries).toContain(t);
    for (const t of ["REFERENCE", "QUOTATION", "RELATED", "ALLUSION", "MESORAT_HASHAS", "EIN_MISHPAT", "OTHER"] as ConnectionType[]) expect(g.links).toContain(t);
    expect(g.direction).toEqual(["SOURCE"]);
    expect(g.links).not.toContain("SOURCE");
  });

  it("keeps the order of CONNECTION_TYPES inside each group (the ids in the database are the order)", () => {
    for (const list of [g.commentaries, g.links]) {
      const idx = list.map((t) => CONNECTION_TYPES.indexOf(t));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
  });

  it("every type has a Hebrew name and a short description", () => {
    for (const t of all) {
      expect(TYPE_LABELS[t].he.length).toBeGreaterThan(0);
      expect(TYPE_LABELS[t].hint.length).toBeGreaterThan(0);
    }
  });
});
