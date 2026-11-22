import { describe, expect, it } from "vitest";
import { runOrder } from "../../../src/linking/batch-job";

/*
 * QA round 2, I: Intl.Collator("he", { numeric: true }) compares "ביאור 02" and "ביאור 2" as equal, and a stable
 * sort then keeps the INPUT order: the same folder, listed in another order by another file system, ran in another order.
 */
describe("runOrder breaks ties the collator leaves", () => {
  it("titles that compare equal run in one order whatever order they arrive in", () => {
    const titles = ["ביאור 02", "ביאור 2", "ביאור 002"];
    const a = runOrder(titles, new Map());
    expect(runOrder([...titles].reverse(), new Map())).toEqual(a);
    expect(runOrder([titles[1]!, titles[2]!, titles[0]!], new Map())).toEqual(a);
    expect(a).toHaveLength(3);
  });
  it("natural order is unchanged for titles that differ", () => {
    expect(runOrder(["ביאור 10", "ביאור 2", "ביאור 1"], new Map())).toEqual(["ביאור 1", "ביאור 2", "ביאור 10"]);
  });
});
