import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { KeyValueStore } from "../../../src/state/services";
import { AppStore, type AutosaveWindow } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Issue #41 B17, B21 and #42 C30 (V7 §1.2): the browser's autosave is one store for every window of the
 * tool. Each window must save under its own key — the last write must not erase another window's work —
 * and what a closed window left behind is offered once, to one window. Opening a saved project over
 * unsaved work keeps that work recoverable, also after a refresh.
 */
const memKv = () => {
  const mem = new Map<string, string>();
  const kv: Required<KeyValueStore> = {
    get: async (k) => mem.get(k) ?? null,
    set: async (k, v) => void mem.set(k, v),
    delete: async (k) => void mem.delete(k),
    keys: async () => [...mem.keys()],
  };
  return { mem, kv };
};
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const newStore = () => new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
/** a links file of `n` records of one commentary on בראשית: n links, no books needed */
const links = (title: string, n: number) => ({
  path: `${title}_links.json`,
  blob: new Blob([JSON.stringify(Array.from({ length: n }, (_, i) => ({ line_index_1: i + 2, heRef_2: "בראשית א", path_2: "בראשית.txt", line_index_2: i + 3, "Conection Type": "commentary" })))]),
});
const windowOf = (id: string, live: () => Set<string>): AutosaveWindow => ({ id, live: async () => live() });

describe("autosave of several windows (B17)", () => {
  it("two windows keep their own work: the last write does not erase the other's", async () => {
    const { mem, kv } = memKv();
    const open = new Set(["a", "b"]);
    const a = newStore();
    const b = newStore();
    a.startAutosave(kv, 0, windowOf("a", () => open));
    b.startAutosave(kv, 0, windowOf("b", () => open));
    await a.openFiles([links("פירוש א", 5)]);
    await b.openFiles([links("פירוש ב", 4)]);
    await tick();
    a.deleteLinks([a.allLinks.value[0]!.id]); // an edit in A after B saved
    await tick();
    const saved = [...mem.entries()].filter(([k]) => k.startsWith("autosave:v1")).map(([, v]) => JSON.parse(v) as { links: unknown[] });
    const counts = saved.map((p) => p.links.length).sort();
    expect(counts).toEqual([4, 5]); // A: 5 records, one marked deleted (still in the project); B: 4
  });

  it("what a closed window left is offered to the next window, once; a window still open is left alone", async () => {
    const { kv } = memKv();
    const open = new Set(["a", "b"]);
    const a = newStore();
    const b = newStore();
    a.startAutosave(kv, 0, windowOf("a", () => open));
    b.startAutosave(kv, 0, windowOf("b", () => open));
    await a.openFiles([links("פירוש א", 5)]);
    await b.openFiles([links("פירוש ב", 4)]);
    await tick();
    open.delete("a"); // A was closed (or crashed)
    open.add("c");
    const c = newStore();
    c.startAutosave(kv, 0, windowOf("c", () => open));
    await tick();
    expect(c.recovery.value?.links).toBe(5); // A's work, not B's (B is still open and owns it)
    c.recovery.value!.restore();
    expect(c.allLinks.value).toHaveLength(5);
    // a fourth window does not get A's work again
    open.add("d");
    const d = newStore();
    d.startAutosave(kv, 0, windowOf("d", () => open));
    await tick();
    expect(d.recovery.value).toBeNull();
  });

  it("a refresh of a window offers that window's own work back", async () => {
    const { kv } = memKv();
    const open = new Set(["a"]);
    const a = newStore();
    a.startAutosave(kv, 0, windowOf("a", () => open));
    await a.openFiles([links("פירוש א", 3)]);
    await tick();
    const again = newStore(); // the same tab after a refresh: same window id
    again.startAutosave(kv, 0, windowOf("a", () => open));
    await tick();
    expect(again.recovery.value?.links).toBe(3);
  });

  it("the single key of older versions is offered once and then moved aside", async () => {
    const { mem, kv } = memKv();
    const old = newStore();
    old.startAutosave(kv, 0); // no window: the key of older versions
    await old.openFiles([links("פירוש ישן", 2)]);
    await tick();
    expect(mem.has("autosave:v1")).toBe(true);
    const open = new Set(["x"]);
    const s = newStore();
    s.startAutosave(kv, 0, windowOf("x", () => open));
    await tick();
    expect(s.recovery.value?.links).toBe(2);
    expect(mem.has("autosave:v1")).toBe(false);
  });

  it("a failed save is reported once, and the next change tries again", async () => {
    const { mem, kv } = memKv();
    let fail = true;
    const flaky: KeyValueStore = { ...kv, set: async (k, v) => (fail ? Promise.reject(new Error("QuotaExceededError")) : kv.set(k, v)) };
    const open = new Set(["a"]);
    const a = newStore();
    a.startAutosave(flaky, 0, windowOf("a", () => open));
    await a.openFiles([links("פירוש א", 3)]);
    await tick();
    expect(a.autosave.value).toBe("failed");
    expect(a.notices.value.filter((n) => n.text.includes("השמירה האוטומטית")).length).toBe(1);
    fail = false;
    a.deleteLinks([a.allLinks.value[0]!.id]);
    await tick();
    expect(a.autosave.value).toBe("saved");
    expect([...mem.keys()].some((k) => k.startsWith("autosave:v1:w:a"))).toBe(true);
  });
});

describe("opening a project over unsaved work (B21)", () => {
  it("keeps the unsaved work recoverable: an action brings it back, and it is offered again after a refresh", async () => {
    const { kv } = memKv();
    const open = new Set(["a"]);
    const a = newStore();
    a.startAutosave(kv, 0, windowOf("a", () => open));
    await a.openFiles([links("פירוש גדול", 30)]);
    await tick();
    const project = (() => {
      const p = newStore();
      return p.openFiles([links("פירוש קטן", 5)]).then(() => p.projectText());
    })();
    a.openProject("קטן.otzlinker.json", await project);
    expect(a.allLinks.value).toHaveLength(5);
    const notice = a.notices.value.find((n) => n.action && n.text.includes("30"));
    expect(notice).toBeTruthy();
    await tick();
    // the browser is refreshed: the 30 links are still offered
    const again = newStore();
    again.startAutosave(kv, 0, windowOf("a", () => open));
    await tick();
    const offered: number[] = [];
    while (again.recovery.value) {
      offered.push(again.recovery.value.links);
      again.recovery.value.dismiss();
    }
    expect(offered).toContain(30);
    // and the action of the notice brings them back in the same session
    notice!.action!.run();
    expect(a.allLinks.value).toHaveLength(30);
  });

  it("a project opened over work that was saved replaces it without a warning", async () => {
    const a = newStore();
    await a.openFiles([links("פירוש גדול", 3)]);
    a.saveProject();
    const p = newStore();
    await p.openFiles([links("פירוש קטן", 2)]);
    a.openProject("קטן.otzlinker.json", p.projectText());
    expect(a.notices.value.some((n) => n.action && n.text.includes("לא נשמרה"))).toBe(false);
  });
});

describe("more closed windows than the recovery queue holds (V7 PR1 review, finding 3)", () => {
  it("no window's work is deleted: what does not fit stays stored and is offered at a later start", async () => {
    const { mem, kv } = memKv();
    const open = new Set(["a", "b", "c", "d"]);
    let n = 1;
    for (const id of ["a", "b", "c", "d"]) {
      const s = newStore();
      s.startAutosave(kv, 0, windowOf(id, () => open));
      await s.openFiles([links(`פירוש ${id}`, n++)]);
    }
    await tick(50);
    open.clear();
    const seen: number[] = [];
    // window after window starts and dismisses what it is offered: every closed window's work comes up once
    for (const id of ["e", "f", "g"]) {
      open.add(id);
      const w = newStore();
      w.startAutosave(kv, 0, windowOf(id, () => open));
      await tick(50);
      while (w.recovery.value) {
        seen.push(w.recovery.value.links);
        w.recovery.value.dismiss();
      }
      await tick(20);
    }
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
    expect([...mem.keys()].filter((k) => k.startsWith("autosave:v1"))).toEqual([]);
  });
});

describe("the replaced work could not be kept in the browser (V7 PR1 review, finding 5)", () => {
  it("the user hears it, instead of a promise that it will be offered again", async () => {
    const { kv } = memKv();
    const failing: KeyValueStore = { ...kv, set: async (k, v) => (k.endsWith(":recovered") ? Promise.reject(new Error("QuotaExceededError")) : kv.set(k, v)) };
    const open = new Set(["a"]);
    const a = newStore();
    a.startAutosave(failing, 0, windowOf("a", () => open));
    await a.openFiles([links("פירוש גדול", 4)]);
    await tick();
    const p = newStore();
    await p.openFiles([links("פירוש קטן", 2)]);
    a.openProject("קטן.otzlinker.json", p.projectText());
    await tick(30);
    expect(a.notices.value.some((n) => n.text.includes("לא הצלחתי לשמור בדפדפן את העבודה הקודמת"))).toBe(true);
  });
});
