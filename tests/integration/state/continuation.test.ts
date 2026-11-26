import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * "This passage continues the previous one" through the store (V7 §2.13, issue #44): a preview first,
 * then ONE undoable step; a heading between the passages needs an explicit confirmation; the export's
 * range rules decide between extending a range and an independent link; the continuation can be
 * cancelled, and a saved project keeps where each link was continued from.
 */
function makeStore() {
  const reg = new SourceRegistry();
  return new AppStore(registryService(reg), { save: () => {} }, loadPreferences(null));
}
const NL = String.fromCharCode(10);
const file = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join(NL))]) });
// line 0 is the title heading, line 5 a chapter heading
const MAIN = file("ספר.txt", ["<h1>ספר</h1>", "א", "ב", "ג", "ד", "<h2>פרק ב</h2>", "ה", "ו", "ז"]);
const NOTES = file("הערות לספר.txt", ["<h1>הערות לספר</h1>", "הערה 1", "הערה 2", "הערה 3"]);

async function opened(files = [MAIN, NOTES], mainTitle = "ספר") {
  const store = makeStore();
  await store.openFiles(files);
  const main = [...store.books.value.values()].find((b) => b.title === mainTitle)!;
  const notes = [...store.books.value.values()].find((b) => b.title === "הערות לספר")!;
  for (const b of [main, notes]) {
    store.lines.line(b.key, 0);
    await vi.waitFor(() => expect(store.lines.count(b.key)).toBeDefined());
  }
  const create = (srcLine: number, tgtLine: number, type = "footnotes") => {
    store.pickLine("source", main.key, srcLine);
    store.pickLine("target", notes.key, tgtLine);
    store.draftType.value = type;
    const l = store.createFromDraft();
    expect(l).not.toBeNull();
    return l!;
  };
  return { store, main, notes, create };
}

describe("continue the previous passage (#44)", () => {
  it("preview first: planning changes nothing; applying is ONE undoable step that extends the range", async () => {
    const { store, main, create } = await opened();
    const prev = create(2, 1);
    const revision = store.linkState.value.revision;
    const plan = await store.ranges.planContinue(main.key, "source", 3);
    expect(plan).not.toBeNull();
    expect(plan!.items.map((i) => i.action)).toEqual(["extend"]);
    expect(store.linkState.value.revision).toBe(revision); // a preview is not a change
    expect(store.ranges.applyContinue(plan!)).toBe(1);
    const ext = store.linkState.value.links.get(prev.id)!;
    expect(ext.source.end).toBe(3);
    expect(ext.continued).toEqual({ kind: "extend", side: "source", fromLine: 2 });
    expect(store.linkState.value.undo.at(-1)!.changes).toHaveLength(1);
    store.undo();
    expect(store.linkState.value.links.get(prev.id)!.source.end).toBeUndefined();
    store.redo();
    expect(store.linkState.value.links.get(prev.id)!.source.end).toBe(3);
  });

  it("inherits several links as independent copies (copy mode), with no duplicates on a second run", async () => {
    const { store, main, create } = await opened();
    create(2, 1);
    create(2, 3, "reference");
    const plan = await store.ranges.planContinue(main.key, "source", 3, "copy");
    expect(store.ranges.applyContinue(plan!)).toBe(2);
    const on3 = store.allLinks.value.filter((l) => l.source.line === 3);
    expect(on3.map((l) => [l.target.line, l.declaredType]).sort()).toEqual([[1, "footnotes"], [3, "reference"]]);
    expect(on3.every((l) => l.continued?.kind === "copy" && l.continued.fromLine === 2)).toBe(true);
    const again = await store.ranges.planContinue(main.key, "source", 3, "copy");
    expect(again!.items.every((i) => i.action === "skip" && i.why === "duplicate")).toBe(true);
    expect(store.ranges.applyContinue(again!)).toBe(0);
    store.undo();
    expect(store.allLinks.value.filter((l) => l.source.line === 3)).toHaveLength(0);
  });

  it("a heading between the passages needs an explicit confirmation", async () => {
    const { store, main, create } = await opened();
    create(4, 1);
    const plan = await store.ranges.planContinue(main.key, "source", 6);
    expect(plan!.headings).toEqual([5]);
    const revision = store.linkState.value.revision;
    expect(store.ranges.applyContinue(plan!)).toBeNull();
    expect(store.linkState.value.revision).toBe(revision);
    expect(store.notices.value.at(-1)?.text).toContain("כותרת");
    expect(store.ranges.applyContinue(plan!, { crossHeading: true })).toBe(1);
  });

  it("a range the export refuses (a Sefaria side, for the library) becomes an independent link", async () => {
    const GEN = file("בראשית.txt", ["<h1>בראשית</h1>", "<h2>פרק א</h2>", "א", "ב", "ג", "ד"]);
    const { store, main, create } = await opened([GEN, NOTES], "בראשית");
    for (const s of store.sources.value) store.setLibrarySource(s.info.id, true);
    expect(store.isSefariaOwned(store.refOf(main.key))).toBe(true);
    const prev = create(2, 1);
    const plan = await store.ranges.planContinue(main.key, "source", 3);
    expect(plan!.items[0]!.action).toBe("copy");
    expect(plan!.items[0]!.why).toBe("range-refused");
    store.ranges.applyContinue(plan!);
    expect(store.linkState.value.links.get(prev.id)!.source.end).toBeUndefined();
    // for private use the same range is fine
    store.exportPurpose.value = "private";
    store.undo();
    const priv = await store.ranges.planContinue(main.key, "source", 3);
    expect(priv!.items[0]!.action).toBe("extend");
  });

  it("cancelling the continuation is its own undoable step", async () => {
    const { store, main, create } = await opened();
    const prev = create(2, 1);
    store.ranges.applyContinue((await store.ranges.planContinue(main.key, "source", 3))!);
    store.ranges.cancelContinuation([prev.id]);
    expect(store.linkState.value.links.get(prev.id)!.source.end).toBeUndefined();
    expect(store.linkState.value.links.get(prev.id)!.continued).toBeUndefined();
    store.undo();
    expect(store.linkState.value.links.get(prev.id)!.source.end).toBe(3);
  });

  it("the notice's undo takes back the continuation only while nothing else was done since", async () => {
    const { store, main, create } = await opened();
    const prev = create(2, 1);
    store.ranges.applyContinue((await store.ranges.planContinue(main.key, "source", 3))!);
    const notice = store.notices.value.at(-1)!;
    expect(notice.action?.label).toBe("ביטול");
    // another action after the continuation: the old notice must not undo it
    const other = create(6, 2);
    notice.action!.run();
    expect(store.linkState.value.links.get(other.id)).toBeDefined();
    expect(store.linkState.value.links.get(prev.id)!.source.end).toBe(3);
    // right after the action, the notice still undoes it (back to before the other link and the continuation first)
    store.undo();
    store.undo();
    expect(store.linkState.value.links.get(prev.id)!.source.end).toBeUndefined();
    store.ranges.applyContinue((await store.ranges.planContinue(main.key, "source", 3))!);
    store.notices.value.at(-1)!.action!.run();
    expect(store.linkState.value.links.get(prev.id)!.source.end).toBeUndefined();
  });

  it("the range-completion notice's undo is guarded the same way", async () => {
    const { store, main, create } = await opened();
    const first = create(1, 1);
    create(3, 2);
    expect(await store.ranges.fill(main.key, "source", false)).toBeGreaterThan(0);
    const notice = store.notices.value.at(-1)!;
    expect(notice.action?.label).toBe("ביטול");
    const filled = store.linkState.value.links.get(first.id)!.source.end;
    expect(filled).toBeDefined();
    const other = create(7, 3);
    notice.action!.run();
    expect(store.linkState.value.links.get(other.id)).toBeDefined();
    expect(store.linkState.value.links.get(first.id)!.source.end).toBe(filled);
  });

  it("a saved project keeps where a link was continued from", async () => {
    const { store, main, create } = await opened();
    create(2, 1);
    store.ranges.applyContinue((await store.ranges.planContinue(main.key, "source", 3, "copy"))!);
    const text = store.projectText();
    const b = await opened();
    b.store.openProject("p.otzlinker.json", text);
    const copy = b.store.allLinks.value.find((l) => l.source.line === 3)!;
    expect(copy.continued).toMatchObject({ kind: "copy", side: "source", fromLine: 2 });
  });
});
