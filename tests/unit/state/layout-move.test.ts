import { describe, expect, it } from "vitest";
import { movePanel, PRESETS, type Layout } from "../../../src/state/preferences";

/*
 * V7 §3.9: the order of the panels can be changed without a mouse — a panel moves one place towards the start or the end, over the
 * hidden panels, and at an edge nothing changes.
 */
describe("moving a panel by one place", () => {
  const four: Layout = structuredClone(PRESETS.four);

  it("swaps it with its visible neighbour", () => {
    expect(movePanel(four, "target", 1).order).toEqual(["sources", "source", "side", "target"]);
    expect(movePanel(four, "target", -1).order).toEqual(["sources", "target", "source", "side"]);
  });

  it("passes over a hidden panel, and at an edge returns the same layout", () => {
    const hidden: Layout = { ...four, hidden: ["source"] };
    expect(movePanel(hidden, "target", -1).order).toEqual(["target", "source", "sources", "side"]);
    expect(movePanel(four, "sources", -1)).toBe(four);
    expect(movePanel(four, "side", 1)).toBe(four);
  });
});
