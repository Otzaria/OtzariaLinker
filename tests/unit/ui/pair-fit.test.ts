import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { fitKey, MAX_AUTO, pairsToAutoCheck } from "../../../src/ui/screens/pair-fit";

const book = (key: string): BookRef => ({ key, title: key, origin: "otzaria" });
const pair = (d: string, b: string, notes = false) => ({ dependant: book(d), base: book(b), notes });

describe("which pairs the plan screen checks by itself", () => {
  it("checks the new ones, not the notes books, not the ones already answered", () => {
    const pairs = [pair("a", "x"), pair("b", "x"), pair("c", "x", true)];
    expect(pairsToAutoCheck(pairs, {}).map((p) => p.dependant.key)).toEqual(["a", "b"]);
    expect(pairsToAutoCheck(pairs, { [fitKey(pairs[0]!)]: { verdict: "fit" } }).map((p) => p.dependant.key)).toEqual(["b"]);
  });

  it("a pair whose check failed (null) is not read again by itself, only by the user's button", () => {
    const pairs = [pair("a", "x")];
    expect(pairsToAutoCheck(pairs, { [fitKey(pairs[0]!)]: null })).toEqual([]);
    expect(pairsToAutoCheck(pairs, { [fitKey(pairs[0]!)]: "loading" })).toEqual([]);
  });

  it("a long list is left to the user", () => {
    const many = Array.from({ length: MAX_AUTO + 1 }, (_, i) => pair(`d${i}`, "x"));
    expect(pairsToAutoCheck(many, {})).toEqual([]);
    expect(pairsToAutoCheck(many.slice(0, MAX_AUTO), {})).toHaveLength(MAX_AUTO);
  });
});
