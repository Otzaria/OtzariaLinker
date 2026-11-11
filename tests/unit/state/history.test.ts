import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Link } from "../../../src/core/links/model";
import { addChanges, commit, deleteChange, editChange, emptyLinkState, historyPosition, linksCount, redo, restoreChange, timeline, travel, undo, type LinkState } from "../../../src/state/history";

const book = { key: "s1:1", title: "א", origin: "otzaria" as const };
const mk = (id: string, over: Partial<Link> = {}): Link => ({
  id, status: "new", provenance: "user", source: { book, line: 1 }, target: { book, line: 2 }, declaredType: "commentary", heRef2: "א ב", ...over,
});

describe("link history", () => {
  it("one action = one undo step, and redo replays it", () => {
    let s = commit(emptyLinkState(), "ייבוא", addChanges([mk("a"), mk("b")]));
    s = commit(s, "מחיקה", [deleteChange(s, "a")!]);
    expect([...s.links.keys()]).toEqual(["b"]);
    s = undo(s);
    expect([...s.links.keys()].sort()).toEqual(["a", "b"]);
    s = undo(s);
    expect(s.links.size).toBe(0);
    s = redo(redo(s));
    expect([...s.links.keys()]).toEqual(["b"]);
  });

  it("editing an imported link marks it edited; deleting it marks it for deletion; restore brings it back", () => {
    const imported = mk("f", { status: "existing", provenance: "file", keyOrder: ["line_index_1"] });
    let s = commit(emptyLinkState(), "ייבוא", addChanges([imported]));
    s = commit(s, "עריכה", [editChange(s, "f", { declaredType: "reference" })!]);
    expect(s.links.get("f")).toMatchObject({ status: "edited", declaredType: "reference" });
    s = commit(s, "מחיקה", [deleteChange(s, "f")!]);
    expect(s.links.get("f")!.status).toBe("deleted");
    s = commit(s, "שחזור", [restoreChange(s, "f")!]);
    expect(s.links.get("f")!.status).toBe("edited");
  });

  it("database links are read-only", () => {
    const s = commit(emptyLinkState(), "x", addChanges([mk("d", { provenance: "db", status: "existing" })]));
    expect(editChange(s, "d", { declaredType: "other" })).toBeNull();
    expect(deleteChange(s, "d")).toBeNull();
  });

  it("a no-op does not create a history entry or a revision", () => {
    const s = commit(emptyLinkState(), "x", []);
    expect(s.revision).toBe(0);
    expect(s.undo).toEqual([]);
  });

  it("property: undoing every step of any sequence returns to the start", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.constantFrom("add", "del", "edit"), fc.integer({ min: 0, max: 5 })), { maxLength: 30 }), (ops) => {
        let s: LinkState = emptyLinkState();
        const snapshots = [s.links];
        for (const [op, n] of ops) {
          const id = `l${n}`;
          const ch = op === "add" ? (s.links.has(id) ? null : { id, after: mk(id) }) : op === "del" ? deleteChange(s, id) : editChange(s, id, { heRef2: `x${s.revision}` });
          if (!ch) continue;
          s = commit(s, op, [ch]);
          snapshots.push(s.links);
        }
        for (let i = snapshots.length - 1; i > 0; i--) {
          expect(s.links).toEqual(snapshots[i]);
          s = undo(s);
        }
        expect(s.links).toEqual(snapshots[0]);
      }),
    );
  });
});

describe("the history list", () => {
  const three = () => {
    let s = commit(emptyLinkState(), "ייבוא", addChanges([mk("a"), mk("b")]), 1000);
    s = commit(s, "יצירת קישור", addChanges([mk("c")]), 2000);
    s = commit(s, "מחיקת קישור", [deleteChange(s, "a")!], 3000);
    return s;
  };

  it("lists every action oldest first, with labels, times, sizes and whether it is applied", () => {
    const s = undo(three());
    expect(timeline(s)).toEqual([
      { label: "ייבוא", at: 1000, changes: 2, position: 1, applied: true },
      { label: "יצירת קישור", at: 2000, changes: 1, position: 2, applied: true },
      { label: "מחיקת קישור", at: 3000, changes: 1, position: 3, applied: false },
    ]);
    expect(historyPosition(s)).toBe(2);
  });

  it("undone actions keep their order after several undos (the redo stack is reversed)", () => {
    const s = undo(undo(three()));
    expect(timeline(s).map((e) => [e.label, e.applied])).toEqual([["ייבוא", true], ["יצירת קישור", false], ["מחיקת קישור", false]]);
  });

  it("travel undoes or redoes to any point, and is the same as that many undo/redo steps", () => {
    const s = three();
    const back = travel(s, 1);
    expect([...back.links.keys()].sort()).toEqual(["a", "b"]);
    expect(historyPosition(back)).toBe(1);
    expect(back.links).toEqual(undo(undo(s)).links);
    const start = travel(s, 0);
    expect(start.links.size).toBe(0);
    expect(timeline(start)).toHaveLength(3); // nothing is forgotten by travelling
    const again = travel(start, 3);
    expect(again.links).toEqual(s.links);
    expect(travel(s, 99).links).toEqual(s.links); // clamped
    expect(travel(s, -1).links.size).toBe(0);
  });

  it("a new action after travelling back drops the undone ones, as undo does", () => {
    let s = travel(three(), 1);
    s = commit(s, "יצירת קישור", addChanges([mk("d")]));
    expect(timeline(s).map((e) => e.label)).toEqual(["ייבוא", "יצירת קישור"]);
    expect(timeline(s).every((e) => e.applied)).toBe(true);
  });

  it("property: travel(p) leaves exactly p actions applied and the links of p steps", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 8 }), (n, back, to) => {
        let s = emptyLinkState();
        const snapshots = [s.links];
        for (let i = 0; i < n; i++) (s = commit(s, `פעולה ${i}`, addChanges([mk(`x${i}`)]))), snapshots.push(s.links);
        for (let i = 0; i < Math.min(back, n); i++) s = undo(s);
        const t = travel(s, Math.min(to, n));
        expect(historyPosition(t)).toBe(Math.min(to, n));
        expect(t.links).toEqual(snapshots[Math.min(to, n)]);
      }),
    );
  });

  it("counts in labels read as Hebrew: one link is קישור אחד", () => {
    expect(linksCount(1)).toBe("קישור אחד");
    expect(linksCount(2)).toBe("2 קישורים");
    expect(linksCount(1200)).toBe("1,200 קישורים");
  });
});
