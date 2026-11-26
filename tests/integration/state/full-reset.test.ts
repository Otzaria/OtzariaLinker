import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { KeyValueStore } from "../../../src/state/services";
import { AppStore, AUTOSAVE_KEY } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Version 3's "איפוס מלא" (F-028): everything the tool holds is closed and forgotten, the files on the disk are not
 * touched. V7 never loses work silently: the project can be saved first, and work that was not saved is kept aside
 * (the browser's recovery queue, and a notice that brings it back).
 */
function makeStore() {
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(registryService(new SourceRegistry()), { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const txt = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const BASE = txt("בסיס.txt", ["<h1>בסיס</h1>", "שורה ראשונה", "שורה שנייה"]);
const COMM = txt("פירוש על בסיס.txt", ["<h1>פירוש על בסיס</h1>", "פירוש ראשון", "פירוש שני"]);
const key = (store: AppStore, title: string) => [...store.books.value.values()].find((b) => b.title === title)!.key;

async function withWork() {
  const made = makeStore();
  const { store } = made;
  await store.openFiles([BASE, COMM]);
  await store.lines.load(key(store, "בסיס"), 0, 3);
  await store.lines.load(key(store, "פירוש על בסיס"), 0, 3);
  store.pickLine("source", key(store, "פירוש על בסיס"), 1);
  store.pickLine("target", key(store, "בסיס"), 1);
  store.createFromDraft();
  return made;
}

describe("full reset (V7 parity F-028)", () => {
  it("closes every source and forgets links and history, back on the home screen; the unsaved work can be brought back", async () => {
    const { store } = await withWork();
    expect(store.dirty.value).toBe(true);
    expect(await store.resetAll()).toBe(true);
    expect(store.sources.value).toEqual([]);
    expect(store.books.value.size).toBe(0);
    expect(store.linkState.value.links.size).toBe(0);
    expect(store.linkState.value.undo).toEqual([]);
    expect(store.dirty.value).toBe(false);
    expect(store.screen.value).toBe("home");
    expect(store.view.source.value).toBeNull();
    const notice = store.notices.value.at(-1)!;
    expect(notice).toMatchObject({ kind: "warning", sticky: true });
    expect(notice.text).toContain("נשמרה בצד");
    notice.action!.run();
    expect(store.linkState.value.links.size).toBe(1);
  });

  it("with saving: the project file is saved first, and nothing is left aside", async () => {
    const { store, saved } = await withWork();
    await store.resetAll({ save: true });
    expect(saved.map((s) => s.name).some((n) => n.endsWith(".otzlinker.json"))).toBe(true);
    expect(store.linkState.value.links.size).toBe(0);
    expect(store.notices.value.at(-1)).toMatchObject({ kind: "success" });
  });

  it("the unsaved work goes to the browser's recovery queue when the autosave runs", async () => {
    const { store } = await withWork();
    const mem = new Map<string, string>();
    const kv: KeyValueStore = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k) };
    store.startAutosave(kv, 0);
    await new Promise((r) => setTimeout(r, 10));
    await store.resetAll();
    await new Promise((r) => setTimeout(r, 10));
    const queue = JSON.parse(mem.get(`${AUTOSAVE_KEY}:recovered`) ?? "[]") as string[];
    expect(queue).toHaveLength(1);
    expect(JSON.parse(queue[0]!).links).toHaveLength(1);
  });

  it("not while a task runs", async () => {
    const { store } = await withWork();
    let release!: () => void;
    const running = store.runTask("עבודה", () => new Promise<void>((r) => (release = r)));
    expect(await store.resetAll()).toBe(false);
    expect(store.linkState.value.links.size).toBe(1);
    release();
    await running;
  });
});
