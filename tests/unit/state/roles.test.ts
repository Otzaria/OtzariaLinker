import { describe, expect, it } from "vitest";
import { ENGINES, type EngineId } from "../../../src/linking/automatic";
import { inRole, ROLE_LABELS, roleKindOf, roleLabels } from "../../../src/state/roles";

/*
 * Issue 19: "מקור"/"יעד" read as files or as roles, and for a commentary the source is the commentary, not the base.
 * The names of the two sides follow the job (commentary, footnotes, citations) — presentation only: the ids `source` and
 * `target`, the stored form and the hashes are not touched (storedForm and the contract tests keep passing).
 */
describe("role names per job", () => {
  it("a commentary job: the source is the commentary, the target its base", () => {
    expect(roleLabels("headings")).toBe(ROLE_LABELS.commentary);
    expect(roleLabels("dibur-hamatchil")).toBe(ROLE_LABELS.commentary);
    expect(ROLE_LABELS.commentary.source.name).toBe("ספר הפירוש");
    expect(ROLE_LABELS.commentary.target.name).toBe("ספר הבסיס");
  });

  it("footnotes: the book body and the book of notes", () => {
    expect(roleKindOf("footnotes")).toBe("notes");
    expect(ROLE_LABELS.notes.source.name).toBe("גוף הספר");
    expect(ROLE_LABELS.notes.target.name).toBe("ספר ההערות");
  });

  it("citations: the citing book and the cited book", () => {
    expect(roleKindOf("citations")).toBe("citations");
    expect(ROLE_LABELS.citations.source.name).toBe("הספר המפנה");
    expect(ROLE_LABELS.citations.target.name).toBe("הספר המצוטט");
  });

  it("no job (the manual builder), a pattern, or an unknown engine: the neutral pair, with the long wording as the hint", () => {
    for (const e of [undefined, null, "pattern", "no-such-engine"] as unknown as (EngineId | undefined | null)[]) expect(roleKindOf(e)).toBe("generic");
    expect(ROLE_LABELS.generic.source).toMatchObject({ name: "ספר המקור", short: "מקור", hint: "ספר שממנו יוצא הקישור" });
    expect(ROLE_LABELS.generic.target).toMatchObject({ name: "ספר היעד", short: "יעד", hint: "הספר שאליו מפנים" });
  });

  it("agrees with the engines' own role text: the source of a commentary engine is the commentary on both screens", () => {
    const e = (id: EngineId) => ENGINES.find((x) => x.id === id)!;
    expect(e("headings").sourceRole).toContain(ROLE_LABELS.commentary.source.name.replace("ספר ", ""));
    expect(e("headings").targetRole).toBe(ROLE_LABELS.commentary.target.name);
    expect(e("footnotes").targetRole).toBe(ROLE_LABELS.notes.target.name);
  });

  it("'in the …' for a role name drops the article of the name", () => {
    expect(inRole("ספר המקור")).toBe("בספר המקור");
    expect(inRole("הספר המפנה")).toBe("בספר המפנה");
    expect(inRole("גוף הספר")).toBe("בגוף הספר");
    expect(inRole("ספר ההערות")).toBe("בספר ההערות");
  });

  it("every kind names both sides, and the two sides never share a name", () => {
    for (const kind of Object.keys(ROLE_LABELS) as (keyof typeof ROLE_LABELS)[]) {
      const { source, target } = ROLE_LABELS[kind];
      for (const r of [source, target]) for (const f of [r.name, r.short, r.hint, r.from]) expect(f.length).toBeGreaterThan(0);
      expect(source.name).not.toBe(target.name);
      expect(source.short).not.toBe(target.short);
    }
  });
});
