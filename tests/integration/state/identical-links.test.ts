import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * V3 rejected creating, editing into, or restoring a link IDENTICAL to a live one (legacy LinkService: dedupKey, restore and
 * update; parity rows F-070, F-072, F-086). V4 created the copy and only warned at export (export/duplicate). "Identical" is
 * the one equality rule (core/links/equality.ts identicalLinkKey): the same stored lines and the same stored type, after
 * Otzaria's conversion. Another link between the same two lines (another type) is NOT identical, and is made. Imported data
 * keeps its duplicates: they are flagged (export/duplicate) and "delete duplicates" removes them.
 */
const txt = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const A = ["<h1>ספר א</h1>", "שורה א1", "שורה א2", "שורה א3", "שורה א4"];
const B = ["<h1>ספר ב</h1>", "שורה ב1", "שורה ב2", "שורה ב3", "שורה ב4"];

async function opened() {
  const store = new AppStore(registryService(), { save: () => {} }, loadPreferences(null));
  await store.openFiles([txt("lib/ספר א.txt", A), txt("lib/ספר ב.txt", B)]);
  const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
  const make = (sLine: number, tLine: number, type = "reference", from = key("ספר א"), to = key("ספר ב")) => {
    store.pickLine("source", from, sLine);
    store.pickLine("target", to, tLine);
    store.draftType.value = type;
    store.draftTypeTouched.value = true;
    return store.createFromDraft();
  };
  return { store, a: key("ספר א"), b: key("ספר ב"), make };
}
const live = (s: AppStore) => s.allLinks.value.filter((l) => l.status !== "deleted");
const codes = (s: AppStore) => s.draftProblems.value.map((p) => `${p.severity}:${p.code}`);

describe("an identical link is not made again (F-070, F-072, F-086)", () => {
  it("create: the same lines and type again is refused, and the builder says why in Hebrew", async () => {
    const { store, a, b, make } = await opened();
    expect(make(1, 2)).not.toBeNull();
    store.pickLine("source", a, 1);
    store.pickLine("target", b, 2);
    expect(codes(store)).toContain("error:builder/identical");
    expect(store.draftProblems.value.find((p) => p.code === "builder/identical")!.message).toMatch(/כבר קיים/);
    expect(store.createFromDraft()).toBeNull();
    expect(live(store)).toHaveLength(1);
  });

  it("create: identical after Otzaria's conversion (a 'source' link the other way) is refused too", async () => {
    const { store, a, b, make } = await opened();
    expect(make(1, 2, "commentary")).not.toBeNull();
    // the generator stores "source" reversed, as commentary: ספר ב:2 → ספר א:1 "source" is the same stored link
    expect(make(2, 1, "source", b, a)).toBeNull();
    expect(live(store)).toHaveLength(1);
  });

  it("create: another link between the same two lines (another type) is not identical — it is made, with a note", async () => {
    const { store, a, b, make } = await opened();
    expect(make(1, 2, "reference")).not.toBeNull();
    store.pickLine("source", a, 1);
    store.pickLine("target", b, 2);
    store.draftType.value = "commentary";
    expect(codes(store)).not.toContain("error:builder/identical");
    expect(codes(store)).toContain("info:builder/same-lines");
    expect(store.createFromDraft()).not.toBeNull();
    expect(live(store)).toHaveLength(2);
    // and a range or an anchor alone does not make a different link: the database keeps one row
    store.pickLine("source", a, 1);
    store.pickLine("target", b, 2);
    store.pickLine("target", b, 3, true);
    store.draftType.value = "reference";
    expect(codes(store)).toContain("error:builder/identical");
  });

  it("edit: a link edited into a copy of another live link is refused; editing it in place is not", async () => {
    const { store, b, make } = await opened();
    const first = make(1, 2)!;
    const second = make(1, 3)!;
    store.editInBuilder(second.id);
    expect(codes(store)).not.toContain("error:builder/identical"); // the link itself is not a copy of itself
    store.pickLine("target", b, 2);
    expect(codes(store)).toContain("error:builder/identical");
    expect(store.createFromDraft()).toBeNull();
    expect(store.linkState.value.links.get(second.id)!.target.line).toBe(3);
    // a change that keeps it different is saved
    store.pickLine("target", b, 4);
    expect(store.createFromDraft()).not.toBeNull();
    expect(store.linkState.value.links.get(second.id)!.target.line).toBe(4);
    expect(store.linkState.value.links.get(first.id)!.target.line).toBe(2);
  });

  // (a link the user made is removed when deleted; a library record is marked, and can be restored)
  it("restore: a deleted record whose identical link was made meanwhile stays deleted, and the user is told", async () => {
    const { store, make } = await opened();
    const rec = (l1: number, l2: number) => ({ line_index_1: l1, heRef_2: `ספר ב ${l2}`, path_2: "ספר ב.txt", line_index_2: l2, "Conection Type": "reference" });
    store.exchange.importLinksFile("ספר א_links.json", JSON.stringify([rec(2, 3), rec(4, 5)], null, 2));
    const [first, other] = live(store);
    store.deleteLinks([first!.id, other!.id]);
    const again = make(1, 2)!; // the same lines (1-based 2 → 3) and type as the deleted record
    expect(again).not.toBeNull();
    store.restoreLinks([first!.id, other!.id]);
    expect(store.linkState.value.links.get(first!.id)!.status).toBe("deleted");
    expect(store.notices.value.some((n) => n.kind === "warning" && /לא שוחזר/.test(n.text) && /זהה/.test(n.text))).toBe(true);
    // a deleted record with no identical live link is restored as before, untouched
    expect(store.linkState.value.links.get(other!.id)!.status).toBe("existing");
    expect(live(store).map((l) => l.id).sort()).toEqual([again.id, other!.id].sort());
  });

  it("restore: of two deleted identical records restored together, one comes back, not both", async () => {
    const { store } = await opened();
    const rec = { line_index_1: 2, heRef_2: "ספר ב 3", path_2: "ספר ב.txt", line_index_2: 3, "Conection Type": "reference" };
    store.exchange.importLinksFile("ספר א_links.json", JSON.stringify([rec, rec], null, 2));
    const ids = live(store).map((l) => l.id);
    store.deleteLinks(ids);
    expect(live(store)).toHaveLength(0);
    store.restoreLinks(ids);
    expect(live(store)).toHaveLength(1);
  });

  // V7 round 2 review, finding 8: a library file with two identical records (what export/duplicate flags) — editing one of them,
  // even only to fix a typo in its heRef_2, was refused as "identical". An edit that keeps the link's identity adds no copy that
  // was not there; an edit that BECOMES identical to another link still does.
  it("edit: one of two identical imported records can be edited when its identity does not change", async () => {
    const { store } = await opened();
    const rec = { line_index_1: 2, heRef_2: "ספר ב 3", path_2: "ספר ב.txt", line_index_2: 3, "Conection Type": "reference" };
    store.exchange.importLinksFile("ספר א_links.json", JSON.stringify([rec, rec], null, 2));
    const [first, second] = live(store);
    store.editInBuilder(first!.id);
    store.draftHeRef.value = "ספר ב, שורה 3";
    expect(codes(store)).not.toContain("error:builder/identical");
    expect(codes(store)).toContain("info:builder/identical-kept");
    expect(store.createFromDraft()).not.toBeNull();
    expect(store.linkState.value.links.get(first!.id)!.heRef2).toBe("ספר ב, שורה 3");
    expect(store.linkState.value.links.get(second!.id)!.heRef2).toBe("ספר ב 3");
  });

  it("edit: a link of an identical pair edited into a copy of a THIRD link is still refused", async () => {
    const { store, b, make } = await opened();
    const rec = { line_index_1: 2, heRef_2: "ספר ב 3", path_2: "ספר ב.txt", line_index_2: 3, "Conection Type": "reference" };
    store.exchange.importLinksFile("ספר א_links.json", JSON.stringify([rec, rec], null, 2));
    const [first] = live(store);
    const third = make(1, 4)!;
    store.editInBuilder(first!.id);
    store.pickLine("target", b, 4); // now the same as `third`
    expect(codes(store)).toContain("error:builder/identical");
    expect(store.createFromDraft()).toBeNull();
    expect(store.linkState.value.links.get(first!.id)!.target.line).toBe(2);
    expect(store.linkState.value.links.get(third.id)!.target.line).toBe(4);
  });

  it("imported data keeps its duplicates: flagged at export, and 'delete duplicates' removes them", async () => {
    const { store } = await opened();
    const rec = { line_index_1: 2, heRef_2: "ספר ב 3", path_2: "ספר ב.txt", line_index_2: 3, "Conection Type": "reference" };
    store.exchange.importLinksFile("ספר א_links.json", JSON.stringify([rec, rec], null, 2));
    expect(live(store)).toHaveLength(2);
    const report = (await store.quality.run())!;
    const dups = report.issues.filter((i) => i.problem.code === "export/duplicate");
    expect(dups).toHaveLength(1);
    expect(store.fixes.removeDuplicates(live(store).map((l) => l.id))).toBe(1);
    expect(live(store)).toHaveLength(1);
  });
});

describe("several picked lines (V3 F-061) keep the identical-link rule (F-070, F-086)", () => {
  it("a batch where one line's link is identical to a live one is refused whole, and the builder says why", async () => {
    const { store, a, b, make } = await opened();
    expect(make(3, 2)).not.toBeNull();
    store.pickLine("source", a, 1);
    store.toggleLine("source", a, 3);
    store.toggleLine("source", a, 4);
    store.pickLine("target", b, 2);
    store.draftType.value = "reference";
    store.draftTypeTouched.value = true;
    expect(store.drafts.value.map((d) => d.source.line)).toEqual([1, 3, 4]);
    expect(codes(store)).toContain("error:builder/identical");
    expect(store.createFromDraft()).toBeNull();
    expect(live(store)).toHaveLength(1);
  });

  it("a batch with only another type on one line's pair is made, with the note", async () => {
    const { store, a, b, make } = await opened();
    expect(make(3, 2, "commentary")).not.toBeNull();
    store.pickLine("source", a, 1);
    store.toggleLine("source", a, 3);
    store.pickLine("target", b, 2);
    store.draftType.value = "reference";
    store.draftTypeTouched.value = true;
    expect(codes(store)).not.toContain("error:builder/identical");
    expect(codes(store)).toContain("info:builder/same-lines");
    expect(store.createFromDraft()).not.toBeNull();
    expect(live(store)).toHaveLength(3);
  });
});

describe("a copy saved as another link (V7 §3.10) keeps the identical-link rule (F-070, F-086)", () => {
  it("a copy identical to ANOTHER live link is refused, with the reason; the edited link is unchanged", async () => {
    const { store, a, b, make } = await opened();
    const first = make(1, 2)!;
    expect(make(1, 3)).not.toBeNull();
    store.editInBuilder(first.id);
    store.pickLine("target", b, 3);
    expect(store.createFromDraft({ asNew: true })).toBeNull();
    expect(live(store)).toHaveLength(2);
    expect(store.notices.value.some((n) => /קישור זהה כבר קיים/.test(n.text))).toBe(true);
    expect(store.linkState.value.links.get(first.id)).toMatchObject({ source: { line: 1 }, target: { line: 2 } });
    void a;
  });
});
