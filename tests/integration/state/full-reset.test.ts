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

  // changed on purpose in V7 round 2 (review finding 7): it said "nothing is left aside", but the tool cannot know the
  // download succeeded — the work is kept aside as well, and the notice says why
  it("with saving: the project file is saved first, and the work is kept aside as well", async () => {
    const { store, saved } = await withWork();
    await store.resetAll({ save: true });
    expect(saved.map((s) => s.name).some((n) => n.endsWith(".otzlinker.json"))).toBe(true);
    expect(store.linkState.value.links.size).toBe(0);
    expect(store.notices.value.at(-1)).toMatchObject({ kind: "info", sticky: true });
    expect(store.notices.value.at(-1)!.text).toContain("אם ההורדה לא הצליחה");
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

/*
 * V7 round-2 review, finding 7: the reset kept work only when it was not saved — but "save first" cannot know the
 * download succeeded; it left behind what the tool knew of the books (edition choices, counts asked, the headings of a
 * whole database), the quality report, the max-link evidence and the import's pending state; and a source opened
 * while the sources were closing was dropped from the list without being closed in the worker.
 */
describe("full reset: nothing lost, nothing left (V7 round-2 review, finding 7)", () => {
  const memKv = () => {
    const mem = new Map<string, string>();
    const kv: KeyValueStore = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k) };
    return { mem, kv };
  };
  type Inner = { editionChoices: { value: ReadonlyMap<string, string> }; editionOffered: Set<string>; countAsked: Set<string> };

  it("with saving, the work still goes to the recovery queue — the download may have failed — and the notice can bring it back", async () => {
    const { store, saved } = await withWork();
    const { mem, kv } = memKv();
    store.startAutosave(kv, 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.resetAll({ save: true })).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(saved.map((s) => s.name).some((n) => n.endsWith(".otzlinker.json"))).toBe(true);
    const queue = JSON.parse(mem.get(`${AUTOSAVE_KEY}:recovered`) ?? "[]") as string[];
    expect(queue).toHaveLength(1);
    expect(JSON.parse(queue[0]!).links).toHaveLength(1);
    const notice = store.notices.value.at(-1)!;
    expect(notice.action?.label).toBe("החזרת העבודה");
    notice.action!.run();
    expect(store.linkState.value.links.size).toBe(1);
  });

  it("forgets what it knew of the books: edition choices and offers, counts asked, the headings read", async () => {
    const { store } = await withWork();
    const inner = store as unknown as Inner;
    expect(await store.headingSearch.build("light")).toBe(true);
    expect(store.headingSearch.status.value).not.toBeNull();
    inner.editionChoices.value = new Map([["x", "y"]]);
    inner.editionOffered.add("x");
    inner.countAsked.add("x");
    await store.resetAll();
    expect(inner.editionChoices.value.size).toBe(0);
    expect(inner.editionOffered.size).toBe(0);
    expect(inner.countAsked.size).toBe(0);
    expect(store.headingSearch.status.value).toBeNull();
    expect((store.headingSearch as unknown as { read: Map<string, unknown> }).read.size).toBe(0);
  });

  it("closing a source forgets the headings read for its books", async () => {
    const { store } = await withWork();
    await store.openFiles([txt("אחר.txt", ["<h1>אחר</h1>", "<h2>פרק</h2>", "שורה"])]);
    expect(await store.headingSearch.build("light")).toBe(true);
    const read = (store.headingSearch as unknown as { read: Map<string, unknown> }).read;
    const other = store.sources.value.find((s) => s.books.some((b) => b.title === "אחר"))!.info.id;
    expect([...read.keys()].some((k) => k.startsWith(`${other}:`))).toBe(true);
    expect(await store.closeSource(other)).toBe(true);
    expect([...read.keys()].some((k) => k.startsWith(`${other}:`))).toBe(false);
    expect(read.size).toBeGreaterThan(0);
  });

  it("forgets the quality report, the max-link evidence and the records waiting for a mapping", async () => {
    const { store } = await withWork();
    expect(await store.quality.run()).not.toBeNull();
    store.maxLink.evidence.value = new Map([["k", []]]);
    store.maxLink.checkedCount.value = 3;
    store.exchange.pendingRecords.value = [{ path: "x.csv" } as never];
    await store.resetAll();
    expect(store.quality.report.value).toBeNull();
    expect(store.maxLink.evidence.value.size).toBe(0);
    expect(store.maxLink.checkedCount.value).toBe(0);
    expect(store.maxLink.report.value).toBeNull();
    expect(store.exchange.pendingRecords.value).toEqual([]);
  });

  it("a source opened while the reset closes the sources is not dropped unclosed: nothing opens until the reset is done", async () => {
    const reg = new SourceRegistry();
    const svc = registryService(reg);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const closed: string[] = [];
    const slow: typeof svc = Object.assign(Object.create(Object.getPrototypeOf(svc) as object) as typeof svc, svc, {
      close: async (id: string) => {
        await gate;
        closed.push(id);
        return svc.close(id);
      },
    });
    const store = new AppStore(slow, { save: () => {} }, loadPreferences(null));
    await store.openFiles([BASE]);
    const resetting = store.resetAll();
    await store.openFiles([COMM]);
    release();
    expect(await resetting).toBe(true);
    // every source the worker holds is one the store lists (or none): no source open in the worker and missing from the list
    const listed = new Set(store.sources.value.map((s) => s.info.id));
    const held = (await svc.open([COMM])).reused?.map((r) => r.info.id) ?? [];
    for (const id of held) expect(listed.has(id)).toBe(true);
    expect(store.sources.value).toEqual([]);
  });
});
