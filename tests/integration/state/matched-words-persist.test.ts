import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { linkToRecord } from "../../../src/formats/links-json/convert";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Issue #11, the part that was open: the words the engine matched stay with an APPROVED link — in the saved project
 * (an optional field of version 1, so an older project still loads) and after a reopen — and never reach the exported
 * `_links.json` record, whose keys are the library's contract. Synthetic books (neutral words).
 */
const nl = String.fromCharCode(10);
const VERSES = ["אלפא בטא גמא דלתא הא וו זין", "כף למד מם נון סמך עין פא", "שין תיו אלף בית גימל דלת הי"];
const DH = ["אלפא בטא גמא", "כף למד מם", "שין תיו אלף"];
const BASE = { path: "ספר בסיס.txt", blob: new Blob([strToU8(["<h1>ספר בסיס</h1>", "<h2>פרק א</h2>", ...VERSES].join(nl))]) };
const COMM = { path: "פירוש על ספר בסיס.txt", blob: new Blob([strToU8(["<h1>פירוש על ספר בסיס</h1>", "<h2>פרק א</h2>", ...DH.map((d, i) => `<b>${d}</b> – הסבר קצר על שורה ${i + 1} כאן`)].join(nl))]) };

function makeStore() {
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(registryService(new SourceRegistry()), { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const book = (store: AppStore, title: string) => [...store.books.value.values()].find((b) => b.title === title)!;

async function approved() {
  const a = makeStore();
  await a.store.openFiles([BASE, COMM]);
  expect(await a.store.suggestions.runEngine("dibur-hamatchil", book(a.store, "פירוש על ספר בסיס").key, book(a.store, "ספר בסיס").key)).toBe(true);
  const list = a.store.suggestions.run.value!.result.suggestions;
  expect(list.length).toBe(3);
  expect(list.every((s) => s.matched?.source && s.matched.target)).toBe(true);
  expect(a.store.suggestions.approve(list.map((s) => s.id))).toBe(3);
  return { ...a, list };
}
const live = (store: AppStore) => store.allLinks.value.filter((l) => l.status !== "deleted");

describe("matched words of an approved link (issue #11)", () => {
  it("approving keeps the suggestion's matched words on the link", async () => {
    const { store, list } = await approved();
    for (const s of list) {
      const l = live(store).find((x) => x.id === `auto:${s.id}`)!;
      expect(l.matched).toEqual(s.matched);
    }
  });

  it("survive a save and a reopen, as a field of the project (still version 1)", async () => {
    const a = await approved();
    const project = a.store.projectText();
    expect(JSON.parse(project).version).toBe(1);
    expect(JSON.parse(project).links.every((l: { matched?: unknown }) => l.matched !== undefined)).toBe(true);

    const b = makeStore();
    await b.store.openFiles([BASE, COMM]);
    b.store.openProject("p.otzlinker.json", project);
    const reopened = live(b.store);
    expect(reopened).toHaveLength(3);
    for (const s of a.list) expect(reopened.find((l) => l.id === `auto:${s.id}`)!.matched).toEqual(s.matched);
  });

  it("an older project (no matched field) loads as before, and a damaged field is dropped without skipping the link", async () => {
    const a = await approved();
    const json = JSON.parse(a.store.projectText());
    const open = async (links: unknown[]) => {
      const b = makeStore();
      await b.store.openFiles([BASE, COMM]);
      b.store.openProject("p.otzlinker.json", JSON.stringify({ ...json, links }));
      return live(b.store);
    };
    const old = await open(json.links.map(({ matched: _m, ...rest }: Record<string, unknown>) => rest));
    expect(old).toHaveLength(3);
    expect(old.every((l) => l.matched === undefined)).toBe(true);
    const bad = [{ source: { rawStart: 5, rawEnd: 2 } }, { source: "x" }, { target: { rawStart: -1, rawEnd: 3 } }, { target: { rawStart: 1.5, rawEnd: 3 } }, [], 7];
    for (const m of bad) {
      const links = await open(json.links.map((l: Record<string, unknown>) => ({ ...l, matched: m })));
      expect(links).toHaveLength(3);
      expect(links.every((l) => l.matched === undefined)).toBe(true);
    }
  });

  it("never reaches the exported record: the keys of _links.json are unchanged", async () => {
    const { store } = await approved();
    for (const l of live(store)) {
      expect(l.matched).toBeTruthy();
      const keys = Object.keys(linkToRecord(l)).sort();
      const { matched: _m, ...without } = l;
      expect(keys).toEqual(Object.keys(linkToRecord(without)).sort());
      expect(JSON.stringify(linkToRecord(l))).toBe(JSON.stringify(linkToRecord(without)));
    }
  });

  it("an edit in the builder keeps the words of the side the user did not change, and drops the side that moved", async () => {
    const { store, list } = await approved();
    const base = book(store, "ספר בסיס");
    await store.lines.load(base.key, 0, 6);
    const l = live(store)[0]!;
    const original = list.find((s) => `auto:${s.id}` === l.id)!.matched!;
    // a type change alone: both sides stay
    store.setType([l.id], "reference");
    expect(store.allLinks.value.find((x) => x.id === l.id)!.matched).toEqual(original);
    // the target moved to another line of the base: its words are not the link's any more; the source's still are
    store.editInBuilder(l.id);
    const elsewhere = [2, 3, 4].find((i) => i !== l.target.line && i !== l.source.line)!;
    store.pickLine("target", base.key, elsewhere);
    expect(store.createFromDraft()).toBeTruthy();
    const after = store.allLinks.value.find((x) => x.id === l.id)!;
    expect(after.target.line).toBe(elsewhere);
    expect(after.matched?.target).toBeUndefined();
    expect(after.matched?.source).toEqual(original.source);
  });
});
