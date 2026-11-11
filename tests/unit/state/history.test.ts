import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Link } from "../../../src/core/links/model";
import { addChanges, commit, deleteChange, editChange, emptyLinkState, redo, restoreChange, undo, type LinkState } from "../../../src/state/history";

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
