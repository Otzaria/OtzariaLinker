import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import type { Suggestion } from "../../../src/linking/automatic";
import { SourceRegistry } from "../../../src/sources/registry";
import { suggestionFacets, suggestionMatches, type SuggestionFilter, type SuggestionState } from "../../../src/state/suggestions";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Reviewing a run's suggestions (V7 §3.11): taking a decision back, and the filters of the table. Over the real Bereshit slice
 * (tests/fixtures/db/seforim-v7-mini.db) and a commentary written verse by verse, as in store.test.ts.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const HEB = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
const BIUR = {
  path: "ביאור על בראשית.txt",
  blob: new Blob([strToU8(["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])].join("\n"))]),
};

async function ran() {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
  await store.openFiles([DB, BIUR]);
  const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
  expect(await store.suggestions.runEngine("headings", key("ביאור על בראשית"), key("בראשית"))).toBe(true);
  return store;
}

describe("taking a decision back (#41 B22)", () => {
  it("reset on an approved suggestion removes its link and returns it to pending — not rejected — in one undoable step", async () => {
    const store = await ran();
    const [id] = store.suggestions.pendingAtLeast("certain");
    store.suggestions.approve([id!]);
    expect(store.suggestions.state.value.get(id!)).toBe("approved");
    const steps = store.linkState.value.undo.length;
    store.suggestions.reset([id!]);
    expect(store.suggestions.state.value.get(id!)).toBe("pending");
    expect(store.allLinks.value.filter((l) => l.status !== "deleted")).toEqual([]);
    expect(store.linkState.value.rejected.size).toBe(0);
    expect(store.linkState.value.undo.length).toBe(steps + 1);
    expect(store.linkState.value.undo.at(-1)!.label).toBe("החזרת הצעה להמתנה");
    store.undo();
    expect(store.suggestions.state.value.get(id!)).toBe("approved");
  });

  it("reset on a mixed selection (approved, rejected, pending) returns every one to pending", async () => {
    const store = await ran();
    const [a, b, c] = store.suggestions.pendingAtLeast("certain");
    store.suggestions.approve([a!]);
    store.suggestions.reject([b!]);
    store.suggestions.reset([a!, b!, c!]);
    expect([a, b, c].map((id) => store.suggestions.state.value.get(id!))).toEqual(["pending", "pending", "pending"]);
    expect(store.linkState.value.undo.at(-1)!.label).toBe("החזרת 2 הצעות להמתנה");
  });
});

describe("the table's filters (V7 §3.11): confidence, state, method, target book, connection type", () => {
  const book = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria" });
  const C = book("c", "ביאור על בראשית");
  const B = book("b", "בראשית");
  const R = book("r", 'רש"י על בראשית');
  const sug = (i: number, over: Partial<Suggestion> = {}): Suggestion => ({ id: `s${i}`, engine: "headings", source: { book: C, line: i }, target: { book: B, line: i }, declaredType: "commentary", heRef2: `ה ${i}`, score: 0.9, confidence: "certain", reasons: [], rules: [], alternatives: [], warnings: [], ...over });
  const list: Suggestion[] = [
    sug(1),
    sug(2, { engine: "dibur-hamatchil", confidence: "possible" }),
    sug(3, { target: { book: R, line: 3 }, declaredType: "reference" }),
    // a merged (max-link) suggestion is found by every method it carries
    { ...sug(4), engines: ["headings", "dibur-hamatchil"] } as Suggestion,
  ];
  const states = new Map<string, SuggestionState>([["s1", "approved"], ["s2", "pending"], ["s3", "pending"], ["s4", "rejected"]]);
  const to = (s: Suggestion) => s.target;
  const ids = (f: SuggestionFilter) => list.filter((s) => suggestionMatches(s, f, states.get(s.id)!, to)).map((s) => s.id);

  it("each filter narrows, and they combine", () => {
    expect(ids({})).toEqual(["s1", "s2", "s3", "s4"]);
    expect(ids({ confidence: "possible" })).toEqual(["s2"]);
    expect(ids({ state: "pending" })).toEqual(["s2", "s3"]);
    expect(ids({ engine: "dibur-hamatchil" })).toEqual(["s2", "s4"]);
    expect(ids({ book: 'רש"י על בראשית' })).toEqual(["s3"]);
    expect(ids({ type: "reference" })).toEqual(["s3"]);
    expect(ids({ engine: "headings", state: "pending" })).toEqual(["s3"]);
  });

  it("the choices of each filter are what the run holds, most first", () => {
    const f = suggestionFacets(list, to);
    expect(f.engines).toEqual([["headings", 3], ["dibur-hamatchil", 2]]);
    expect(f.books).toEqual([["בראשית", 3], ['רש"י על בראשית', 1]]);
    expect(f.types).toEqual([["commentary", 3], ["reference", 1]]);
  });
});
