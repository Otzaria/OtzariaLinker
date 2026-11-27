import { describe, expect, it } from "vitest";
import { insertEntryAfter, moveEntry, shiftLevel } from "../../../src/core/alt-toc/edit";
import type { AltTocEntry } from "../../../src/core/alt-toc/model";

/*
 * #25 / V7 §3.18: the alt_toc editor reorders a node, adds one right after another, and moves a node with everything under it one
 * level in or out — and never loses a node.
 */
const E = (heTitle: string, level: number, line = 1): AltTocEntry => ({ heTitle, line, level });
const tree = [E("פרשה א", 0, 1), E("עליה א", 1, 2), E("עליה ב", 1, 4), E("פרשה ב", 0, 7), E("עליה א", 1, 8)];
const names = (es: readonly AltTocEntry[]) => es.map((e) => `${e.level}:${e.heTitle}`);

describe("alt_toc editing: order and hierarchy", () => {
  it("moves one node up or down; at an edge nothing changes", () => {
    expect(names(moveEntry(tree, 2, -1))).toEqual(["0:פרשה א", "1:עליה ב", "1:עליה א", "0:פרשה ב", "1:עליה א"]);
    expect(names(moveEntry(tree, 3, 1))).toEqual(["0:פרשה א", "1:עליה א", "1:עליה ב", "1:עליה א", "0:פרשה ב"]);
    expect(moveEntry(tree, 0, -1)).toBe(tree);
    expect(moveEntry(tree, 4, 1)).toBe(tree);
  });

  it("adds a node right after another, at its level and line", () => {
    const out = insertEntryAfter(tree, 1);
    expect(out).toHaveLength(6);
    expect(out[2]).toEqual({ heTitle: "", line: 2, level: 1 });
    expect(names(out.filter((e) => e.heTitle))).toEqual(names(tree));
  });

  it("indents or outdents a node with the nodes under it; never below level 0", () => {
    expect(names(shiftLevel(tree, 3, 1))).toEqual(["0:פרשה א", "1:עליה א", "1:עליה ב", "1:פרשה ב", "2:עליה א"]);
    expect(names(shiftLevel(tree, 1, -1))).toEqual(["0:פרשה א", "0:עליה א", "1:עליה ב", "0:פרשה ב", "1:עליה א"]);
    expect(shiftLevel(tree, 0, -1)).toBe(tree);
  });
});
