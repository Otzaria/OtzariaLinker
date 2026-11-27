import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * v3's reader and builder capabilities restored in V7 (docs/audit/V7_LEGACY_PARITY.md §3.1): several lines picked with
 * Ctrl/Cmd and one link made from each in one undoable step (F-046/F-061); a range end typed, to the end of the book,
 * or suggested by itself (F-054/F-055); the range settings v3 had (F-079 rangeEndBasis, F-083 rangeTrimPrevious); and
 * the anchor's label (F-075, " אות X" in heRef_2). Real store, real text sources, no fakes.
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

async function opened() {
  const store = makeStore();
  await store.openFiles([MAIN, NOTES]);
  const main = [...store.books.value.values()].find((b) => b.title === "ספר")!;
  const notes = [...store.books.value.values()].find((b) => b.title === "הערות לספר")!;
  for (const b of [main, notes]) {
    store.lines.line(b.key, 0);
    await vi.waitFor(() => expect(store.lines.count(b.key)).toBeDefined());
  }
  store.draftType.value = "footnotes";
  const create = (srcLine: number, tgtLine: number, srcEnd?: number) => {
    store.pickLine("source", main.key, srcLine);
    if (srcEnd !== undefined) store.pickLine("source", main.key, srcEnd, true);
    store.pickLine("target", notes.key, tgtLine);
    const l = store.createFromDraft();
    expect(l).not.toBeNull();
    return l!;
  };
  return { store, main, notes, create };
}

describe("several lines picked with Ctrl/Cmd (v3 F-046, F-061)", () => {
  it("Ctrl toggles a line in and out; one line left is a plain pick, none is no pick", async () => {
    const { store, main } = await opened();
    store.pickLine("source", main.key, 1);
    store.toggleLine("source", main.key, 3);
    expect(store.pick.source.value).toEqual({ bookKey: main.key, line: 1, lines: [1, 3] });
    store.toggleLine("source", main.key, 7);
    expect(store.pick.source.value?.lines).toEqual([1, 3, 7]);
    store.toggleLine("source", main.key, 1);
    expect(store.pick.source.value).toEqual({ bookKey: main.key, line: 3, lines: [3, 7] });
    store.toggleLine("source", main.key, 7);
    expect(store.pick.source.value).toEqual({ bookKey: main.key, line: 3 });
    store.toggleLine("source", main.key, 3);
    expect(store.pick.source.value).toBeNull();
  });

  it("a Shift range and then Ctrl: the range's lines plus the new one, as in v3; Ctrl in another book starts over", async () => {
    const { store, main, notes } = await opened();
    store.pickLine("source", main.key, 1);
    store.pickLine("source", main.key, 3, true);
    store.toggleLine("source", main.key, 7);
    expect(store.pick.source.value).toEqual({ bookKey: main.key, line: 1, lines: [1, 2, 3, 7] });
    store.toggleLine("source", notes.key, 2);
    expect(store.pick.source.value).toEqual({ bookKey: notes.key, line: 2 });
  });

  it("Shift after Ctrl: one range over all the picked lines and the clicked one", async () => {
    const { store, main } = await opened();
    store.pickLine("source", main.key, 2);
    store.toggleLine("source", main.key, 4);
    store.pickLine("source", main.key, 7, true);
    expect(store.pick.source.value).toEqual({ bookKey: main.key, line: 2, end: 7 });
  });

  it("one link from each picked line to the other side's line, in ONE undo step", async () => {
    const { store, main, notes } = await opened();
    store.pickLine("source", main.key, 1);
    store.toggleLine("source", main.key, 3);
    store.toggleLine("source", main.key, 7);
    store.pickLine("target", notes.key, 2);
    expect(store.drafts.value.map((d) => [d.source.line, d.target.line])).toEqual([[1, 2], [3, 2], [7, 2]]);
    expect(store.createFromDraft()).not.toBeNull();
    expect(store.allLinks.value.map((l) => l.source.line).sort()).toEqual([1, 3, 7]);
    expect(store.linkState.value.undo.length).toBe(1);
    expect(store.linkState.value.undo.at(-1)!.label).toBe("יצירת 3 קישורים");
    store.undo();
    expect(store.allLinks.value.length).toBe(0);
  });

  it("several target lines: a link from the one source line to each", async () => {
    const { store, main, notes } = await opened();
    store.pickLine("source", main.key, 2);
    store.pickLine("target", notes.key, 1);
    store.toggleLine("target", notes.key, 3);
    expect(store.createFromDraft()).not.toBeNull();
    expect(store.allLinks.value.map((l) => [l.source.line, l.target.line]).sort()).toEqual([[2, 1], [2, 3]]);
  });

  it("several target lines: a typed place (heRef_2) or ref_2 is not copied to every link; each gets its own line's (V7 round-2 review, finding 1)", async () => {
    const { store, main, notes } = await opened();
    store.pickLine("source", main.key, 2);
    // the place each line gets by itself
    const own = [1, 2, 3].map((i) => {
      store.pickLine("target", notes.key, i);
      return store.draft.value!.heRef2;
    });
    expect(new Set(own).size).toBe(3);
    store.pickLine("target", notes.key, 1);
    store.toggleLine("target", notes.key, 2);
    store.toggleLine("target", notes.key, 3);
    // typed while the three lines are picked (the builder showed the first line's place)
    store.draftHeRef.value = "מקום שהוקלד";
    store.draftRef2.value = "Typed 1:2";
    expect(store.drafts.value.map((d) => [d.target.line, d.heRef2, d.ref2])).toEqual([
      [1, own[0], undefined],
      [2, own[1], undefined],
      [3, own[2], undefined],
    ]);
    expect(store.draftProblems.value.filter((p) => p.severity === "error")).toEqual([]);
    expect(store.createFromDraft()).not.toBeNull();
    const made = store.allLinks.value.sort((a, b) => a.target.line - b.target.line);
    expect(made.map((l) => [l.target.line, l.heRef2, l.ref2])).toEqual([
      [1, own[0], undefined],
      [2, own[1], undefined],
      [3, own[2], undefined],
    ]);
  });

  it("several source lines: a typed ref_1 is not copied to every link; the one target's typed place is kept (finding 1)", async () => {
    const { store, main, notes } = await opened();
    store.pickLine("source", main.key, 1);
    store.pickLine("target", notes.key, 2);
    store.toggleLine("source", main.key, 3);
    store.draftRef1.value = "Typed 1:1";
    store.draftRef2.value = "Target 1:2";
    store.draftHeRef.value = "מקום שהוקלד";
    expect(store.drafts.value.map((d) => [d.source.line, d.ref1, d.ref2, d.heRef2])).toEqual([
      [1, undefined, "Target 1:2", "מקום שהוקלד"],
      [3, undefined, "Target 1:2", "מקום שהוקלד"],
    ]);
  });

  it("several lines on BOTH sides are refused, and the builder says why", async () => {
    const { store, main, notes } = await opened();
    store.pickLine("source", main.key, 1);
    store.toggleLine("source", main.key, 2);
    store.pickLine("target", notes.key, 1);
    store.toggleLine("target", notes.key, 2);
    expect(store.draftProblems.value.find((p) => p.code === "builder/multi-both-sides")?.severity).toBe("error");
    expect(store.createFromDraft()).toBeNull();
    expect(store.allLinks.value.length).toBe(0);
  });

  it("a heading among the picked lines blocks the whole batch, and the problem names the line", async () => {
    const { store, main, notes } = await opened();
    store.pickLine("source", main.key, 4);
    store.toggleLine("source", main.key, 5); // a heading
    store.pickLine("target", notes.key, 1);
    const err = store.draftProblems.value.find((p) => p.severity === "error");
    expect(err?.code).toBe("export/heading-line");
    expect(err?.message).toContain("שורה 6");
    expect(store.createFromDraft()).toBeNull();
    expect(store.allLinks.value.length).toBe(0);
  });

  it("while a link is edited, Ctrl picks one line: an edit is one link", async () => {
    const { store, main, create } = await opened();
    const l = create(1, 1);
    store.editInBuilder(l.id);
    store.toggleLine("source", main.key, 3);
    expect(store.pick.source.value).toEqual({ bookKey: main.key, line: 3 });
  });

  it("new links from several lines cut a range they fall inside once, at the first of them", async () => {
    const { store, main, notes, create } = await opened();
    const wide = create(1, 1, 8);
    store.pickLine("source", main.key, 3);
    store.toggleLine("source", main.key, 7);
    store.pickLine("target", notes.key, 2);
    expect(store.createFromDraft()).not.toBeNull();
    expect(store.linkState.value.links.get(wide.id)!.source.end).toBe(2);
    store.undo();
    expect(store.linkState.value.links.get(wide.id)!.source.end).toBe(8);
  });
});

describe("the range end: typed, to the end of the book, suggested (v3 F-054, F-055)", () => {
  it("a typed end makes a range; an end not after the start removes it; past the book is refused with the reason", async () => {
    const { store, main } = await opened();
    store.pickLine("source", main.key, 1);
    expect(store.setRangeEnd("source", 3)).toBe(true);
    expect(store.pick.source.value).toEqual({ bookKey: main.key, line: 1, end: 3 });
    expect(store.setRangeEnd("source", 1)).toBe(true);
    expect(store.pick.source.value).toEqual({ bookKey: main.key, line: 1 });
    expect(store.setRangeEnd("source", 3)).toBe(true);
    expect(store.setRangeEnd("source", 20)).toBe(false);
    expect(store.pick.source.value?.end).toBe(3);
    expect(store.notices.value.at(-1)?.text).toContain("9 שורות");
  });

  it("until the end of the book: the last line, stepping back from a heading", async () => {
    const { store, main } = await opened();
    store.pickLine("source", main.key, 6);
    expect(await store.rangeToEnd("source")).toBe(true);
    expect(store.pick.source.value?.end).toBe(8);
    const SHORT = file("קצר.txt", ["<h1>קצר</h1>", "א", "ב", "<h2>סוף</h2>"]);
    await store.openFiles([SHORT]);
    const short = [...store.books.value.values()].find((b) => b.title === "קצר")!;
    store.lines.line(short.key, 0);
    await vi.waitFor(() => expect(store.lines.count(short.key)).toBeDefined());
    store.pickLine("source", short.key, 1);
    expect(await store.rangeToEnd("source")).toBe(true);
    expect(store.pick.source.value?.end).toBe(2);
  });

  it("the automatic end (v3 rangeAutoEnd), per side: a new pick there runs until one line before the next link", async () => {
    const { store, main, notes, create } = await opened();
    create(3, 2);
    expect(store.prefs.rangeAutoEnd.value).toEqual({ source: false, target: false });
    store.pickLine("source", main.key, 1);
    await store.whenPicked();
    expect(store.pick.source.value?.end).toBeUndefined();
    store.prefs.rangeAutoEnd.value = { source: true, target: false };
    store.pickLine("source", main.key, 1);
    await store.whenPicked();
    expect(store.pick.source.value).toEqual({ bookKey: main.key, line: 1, end: 2 });
    // the other side stays a line
    store.pickLine("target", notes.key, 1);
    await store.whenPicked();
    expect(store.pick.target.value?.end).toBeUndefined();
    // a Shift range is the user's own: not replaced
    store.pickLine("source", main.key, 6);
    store.pickLine("source", main.key, 7, true);
    await store.whenPicked();
    expect(store.pick.source.value).toEqual({ bookKey: main.key, line: 6, end: 7 });
  });
});

describe("the range settings (v3 F-079 rangeEndBasis, F-083 rangeTrimPrevious)", () => {
  it("what 'until the next' stops at: a link or a heading, a link only, a heading only, the end of the book", async () => {
    const { store, main, create } = await opened();
    create(3, 2);
    const until = async (basis: "auto" | "links" | "headings" | "book", from: number) => {
      store.prefs.rangeEndBasis.value = basis;
      store.pickLine("source", main.key, from);
      expect(await store.untilNext("source")).toBe(true);
      return store.pick.source.value?.end;
    };
    expect(await until("auto", 1)).toBe(2);
    expect(await until("links", 1)).toBe(2);
    expect(await until("headings", 1)).toBe(4);
    expect(await until("book", 1)).toBe(8);
    expect(await until("auto", 3)).toBe(4);
    expect(await until("links", 3)).toBe(8);
  });

  it("trimming the previous range can be turned off: the range stays as it was", async () => {
    const { store, create } = await opened();
    const wide = create(1, 1, 4);
    store.prefs.rangeTrimPrevious.value = false;
    const notices = store.notices.value.length;
    create(3, 2);
    expect(store.linkState.value.links.get(wide.id)!.source.end).toBe(4);
    expect(store.notices.value.length).toBe(notices);
    store.prefs.rangeTrimPrevious.value = true;
    create(4, 3);
    expect(store.linkState.value.links.get(wide.id)!.source.end).toBe(3);
  });
});

describe("the anchor's label (v3 F-075: ' אות X' in heRef_2)", () => {
  const anchored = async () => {
    const o = await opened();
    o.store.pickAnchor("source", o.main.key, 1, { rawStart: 0, rawEnd: 1, text: "א" });
    o.store.pickLine("target", o.notes.key, 2);
    return o;
  };

  it("the label goes into heRef_2, is the anchor's label, is replaced (not appended) and can be removed", async () => {
    const { store } = await anchored();
    const auto = store.draft.value!.heRef2;
    expect(store.setAnchorLabel("ג")).toBe(true);
    expect(store.draft.value!.heRef2).toBe(`${auto} אות ג`);
    expect(store.draft.value!.anchor?.label).toBe("ג");
    expect(store.setAnchorLabel("ד")).toBe(true);
    expect(store.draft.value!.heRef2).toBe(`${auto} אות ד`);
    expect(store.setAnchorLabel("")).toBe(true);
    expect(store.draft.value!.heRef2).toBe(auto);
    expect(store.draft.value!.anchor?.label).toBeUndefined();
  });

  it("a reference the user typed keeps its text, with the label put at its end", async () => {
    const { store } = await anchored();
    store.draftHeRef.value = "הערות לספר, הערה ב";
    expect(store.setAnchorLabel("ב")).toBe(true);
    expect(store.draftHeRef.value).toBe("הערות לספר, הערה ב אות ב");
    expect(store.draft.value!.anchor?.label).toBe("ב");
  });

  it("a label the generator would not read is refused with the reason, and nothing changes", async () => {
    const { store } = await anchored();
    const before = store.draft.value!.heRef2;
    expect(store.setAnchorLabel("12")).toBe(false);
    expect(store.draft.value!.heRef2).toBe(before);
    expect(store.notices.value.at(-1)?.kind).toBe("warning");
  });

  it("the created link carries the label in its reference and its anchor", async () => {
    const { store } = await anchored();
    store.setAnchorLabel("ג");
    const l = store.createFromDraft()!;
    expect(l.anchor).toMatchObject({ rawStart: 0, rawEnd: 1, label: "ג" });
    expect(l.heRef2.endsWith(" אות ג")).toBe(true);
  });
});
