import { strToU8 } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * V7 round 2 review, findings 4 and 5: the check for an IDENTICAL live link (store.twinOf, the builder's draftProblems and
 * restoreLinks) went over every link of the project for each link it checked, and compared line numbers only: links between the
 * same line numbers of OTHER books all reached identicalLinkKey (storedForm). "Restore" of 10,000 of 100,000 links took ~18 s on
 * the main thread, and each keystroke in the builder ~0.5 s. The cost is counted here in calls of identicalLinkKey — not in time,
 * which a loaded machine makes flaky: the live links are indexed once by their two ends (book and line), and only a link on the
 * same two lines of the same two books is compared.
 */
const calls = vi.hoisted(() => ({ identical: 0 }));
vi.mock("../../../src/core/links/equality", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/core/links/equality")>();
  return { ...real, identicalLinkKey: (...a: Parameters<typeof real.identicalLinkKey>) => (calls.identical++, real.identicalLinkKey(...a)) };
});
beforeEach(() => void (calls.identical = 0));

const txt = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const A = ["<h1>ספר א</h1>", "שורה א1", "שורה א2", "שורה א3", "שורה א4"];
const B = ["<h1>ספר ב</h1>", "שורה ב1", "שורה ב2", "שורה ב3", "שורה ב4"];
const live = (s: AppStore) => s.allLinks.value.filter((l) => l.status !== "deleted");

/** "ספר א" line 1 linked to line 2 of `n` other books ("יעד 0".."יעד n-1"): the same line NUMBERS, other books */
const sameNumbers = (n: number) => Array.from({ length: n }, (_, i) => ({ line_index_1: 2, heRef_2: `יעד ${i} 3`, path_2: `יעד ${i}.txt`, line_index_2: 3, "Conection Type": "reference" }));

async function opened() {
  const store = new AppStore(registryService(), { save: () => {} }, loadPreferences(null));
  await store.openFiles([txt("lib/ספר א.txt", A), txt("lib/ספר ב.txt", B)]);
  const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
  return { store, a: key("ספר א"), b: key("ספר ב") };
}

describe("the identical-link check costs one lookup per link, not a pass over the project (findings 4, 5)", () => {
  it("restoring k links among n on the same line numbers of other books: O(k) identity keys, not O(n·k)", async () => {
    const { store } = await opened();
    store.exchange.importLinksFile("ספר א_links.json", JSON.stringify(sameNumbers(400), null, 2));
    const ids = live(store).map((l) => l.id);
    expect(ids).toHaveLength(400);
    const restored = ids.slice(0, 200);
    store.deleteLinks(restored);
    calls.identical = 0;
    store.restoreLinks(restored);
    expect(live(store)).toHaveLength(400); // none is identical to another: every one comes back
    // one key per restored link (and per live link it shares both ends with: none here); before, every live link on the same
    // line numbers was keyed for every restored one — 200 × 200 and more
    expect(calls.identical).toBeLessThanOrEqual(2 * restored.length);
  });

  it("the builder's check of a draft does not key the links of other books on the same line numbers, and a keystroke keys one", async () => {
    const { store, a, b } = await opened();
    store.exchange.importLinksFile("ספר א_links.json", JSON.stringify(sameNumbers(300), null, 2));
    store.pickLine("source", a, 1);
    store.pickLine("target", b, 2);
    calls.identical = 0;
    expect(store.draftProblems.value.filter((p) => p.code.startsWith("builder/"))).toEqual([]);
    expect(calls.identical).toBeLessThanOrEqual(2);
    store.draftHeRef.value = "ספר ב ב";
    calls.identical = 0;
    void store.draftProblems.value;
    expect(calls.identical).toBeLessThanOrEqual(2);
  });

  it("the index answers as before: identical to a live link, identical within the batch, another type on the same lines", async () => {
    const { store, a, b } = await opened();
    const rec = (l1: number, l2: number, type = "reference") => ({ line_index_1: l1, heRef_2: `ספר ב ${l2}`, path_2: "ספר ב.txt", line_index_2: l2, "Conection Type": type });
    // two copies of one record, a third record, and a fourth of another type on the third one's lines
    store.exchange.importLinksFile("ספר א_links.json", JSON.stringify([rec(2, 3), rec(2, 3), rec(4, 5), rec(4, 5, "commentary")], null, 2));
    const [c1, c2, third, fourth] = live(store);
    store.deleteLinks([c1!.id, c2!.id, third!.id]);
    // made meanwhile: identical to `third`
    store.pickLine("source", a, 3);
    store.pickLine("target", b, 4);
    store.draftType.value = "reference";
    store.draftTypeTouched.value = true;
    expect(store.draftProblems.value.map((p) => p.code)).toContain("builder/same-lines"); // `fourth`, another type
    const made = store.createFromDraft()!;
    expect(made).not.toBeNull();
    store.restoreLinks([c1!.id, c2!.id, third!.id]);
    // of the two copies one comes back; `third` stays deleted (its identical link is live)
    expect(live(store).map((l) => l.id).sort()).toEqual([c1!.id, fourth!.id, made.id].sort());
    expect(store.linkState.value.links.get(third!.id)!.status).toBe("deleted");
    // the same line numbers with the books swapped (ספר ב:3 → ספר א:4) are other lines: no twin
    store.pickLine("source", b, 3);
    store.pickLine("target", a, 4);
    store.draftType.value = "reference";
    expect(store.draftProblems.value.map((p) => p.code)).not.toContain("builder/identical");
  });
});
