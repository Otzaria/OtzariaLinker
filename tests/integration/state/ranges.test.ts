import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * The range actions through the store (state/ranges.ts): the builder's "until the next link", the
 * cut of a range a new link falls inside (same undo step), and range completion of a whole book.
 */
function makeStore() {
  const reg = new SourceRegistry();
  const service = registryService(reg);
  return new AppStore(service, { save: () => {} }, loadPreferences(null));
}
const NL = String.fromCharCode(10);
const file = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join(NL))]) });
// line 0 is the title heading, line 5 a chapter heading
const MAIN = file("ספר.txt", ["<h1>ספר</h1>", "א", "ב", "ג", "ד", "<h2>פרק ב</h2>", "ה", "ו", "ז"]);
const NOTES = file("הערות לספר.txt", ["<h1>הערות לספר</h1>", "הערה 1", "הערה 2", "הערה 3"]);

async function opened() {
  const store = makeStore();
  await store.openFiles([MAIN, NOTES]);
  const main = [...store.books.value.values()].find((b) => b.title === "ספר")!;
  const notes = [...store.books.value.values()].find((b) => b.title === "הערות לספר")!;
  // read both books the way the reader does, so their lines and length are known
  for (const b of [main, notes]) {
    store.lines.line(b.key, 0);
    await vi.waitFor(() => expect(store.lines.count(b.key)).toBeDefined());
  }
  const create = (srcLine: number, tgtLine: number, srcEnd?: number) => {
    store.pickLine("source", main.key, srcLine);
    if (srcEnd !== undefined) store.pickLine("source", main.key, srcEnd, true);
    store.pickLine("target", notes.key, tgtLine);
    store.draftType.value = "footnotes";
    const l = store.createFromDraft();
    expect(l).not.toBeNull();
    return l!;
  };
  return { store, main, notes, create };
}

describe("ranges through the store", () => {
  it("until the next link: stops one line before the next link, and before a heading", async () => {
    const { store, main, create } = await opened();
    create(3, 2);
    expect(await store.ranges.suggestEnd(main.key, "source", 1)).toBe(2);
    expect(await store.ranges.suggestEnd(main.key, "source", 3)).toBe(4); // line 5 is a heading
    expect(await store.ranges.suggestEnd(main.key, "source", 6)).toBe(8);
  });

  it("a new link inside another link's range cuts that range — in the same undo step", async () => {
    const { store, create } = await opened();
    const wide = create(1, 1, 4);
    expect(wide.source.end).toBe(4);
    const notices = store.notices.value.length;
    create(3, 2);
    const cut = store.linkState.value.links.get(wide.id)!;
    expect(cut.source.end).toBe(2);
    expect(store.notices.value.length).toBe(notices + 1);
    store.undo();
    expect(store.linkState.value.links.get(wide.id)!.source.end).toBe(4);
    expect(store.allLinks.value.length).toBe(1);
  });

  it("range completion of a book: one step, undoable, and a second run changes nothing", async () => {
    const { store, main, create } = await opened();
    create(1, 1);
    create(3, 2);
    create(6, 3);
    expect(await store.ranges.fill(main.key, "source", false)).toBe(3);
    const ends = store.allLinks.value.map((l) => [l.source.line, l.source.end]).sort((a, b) => a[0]! - b[0]!);
    expect(ends).toEqual([[1, 2], [3, 4], [6, 8]]);
    expect(await store.ranges.fill(main.key, "source", false)).toBe(0);
    store.undo();
    expect(store.allLinks.value.every((l) => l.source.end === undefined)).toBe(true);
  });
});
