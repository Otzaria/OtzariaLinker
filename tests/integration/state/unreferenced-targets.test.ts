import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { Suggestion } from "../../../src/linking/automatic";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { unreferencedLines } from "../../../src/state/suggestions";
import { registryService } from "../../support/books-service";

/*
 * Version 3's diagnosis "יעדים בלי הפניה" (F-102): after a dibur-hamatchil or headings run, the target's content lines
 * that no suggestion points at — between the first and the last line that one does, headings excluded.
 */
const book = { key: "s1:base", title: "בסיס", origin: "unknown" as const };
const comm = { key: "s1:comm", title: "פירוש על בסיס", origin: "unknown" as const };
const sug = (id: string, line: number, over: Partial<Suggestion> = {}): Suggestion =>
  ({ id, engine: "dibur-hamatchil", source: { book: comm, line: 1 }, target: { book, line }, declaredType: "commentary", heRef2: "", score: 1, confidence: "certain", reasons: [], ...over }) as Suggestion;

describe("unreferenced target lines (V7 parity F-102)", () => {
  it("between the first and the last referenced line, without headings; a range and a span count as referenced", () => {
    const r = unreferencedLines([sug("a", 2), sug("b", 9), sug("c", 4, { target: { book, line: 4, end: 5 } }), sug("d", 12, { citedSpan: { line: 12, end: 13 } }), sug("e", 15, { spanLines: [{ line: 15, heRef2: "" }, { line: 16, heRef2: "" }] })], new Set([7]));
    expect(r).toEqual({ lines: [3, 6, 8, 10, 11, 14], from: 2, through: 16, referenced: 5 });
    expect(unreferencedLines([], new Set())).toEqual({ lines: [], from: -1, through: -1, referenced: 0 });
  });

  it("the store answers for a pair run of dibur-hamatchil or headings, reading the target's headings; not for other runs", async () => {
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
    const BASE = { path: "בסיס.txt", blob: new Blob([strToU8(["<h1>בסיס</h1>", "א", "ב", "<h2>פרק ב</h2>", "ג", "ד", "ה"].join("\n"))]) };
    await store.openFiles([BASE]);
    const base = [...store.books.value.values()][0]!;
    const ref = { key: base.key, title: base.title, origin: base.origin };
    const s = (line: number) => sug(`x${line}`, line, { target: { book: ref, line } });
    store.suggestions.run.value = { engine: "dibur-hamatchil", label: "x", at: 0, result: { suggestions: [s(1), s(6)], notes: [], unmatched: [] } };
    expect(await store.suggestions.unreferencedTargets()).toEqual({ bookKey: base.key, title: "בסיס", lines: [2, 4, 5], from: 1, through: 6, referenced: 2 });
    store.suggestions.run.value = { engine: "footnotes", label: "x", at: 0, result: { suggestions: [s(1)], notes: [], unmatched: [] } };
    expect(await store.suggestions.unreferencedTargets()).toBeNull();
    store.suggestions.run.value = { engine: "headings", label: "x", at: 0, batch: [], result: { suggestions: [s(1)], notes: [], unmatched: [] } };
    expect(await store.suggestions.unreferencedTargets()).toBeNull();
  });
});
