import { describe, expect, it } from "vitest";
import { parseDraggedLine } from "../../../src/ui/workspace/line-drag";

/* QA round 2, F: what a drop carries is text from outside the page (another tab, another program may set the same type). */
describe("parseDraggedLine", () => {
  it("accepts what the reader sets and nothing else", () => {
    expect(parseDraggedLine('{"bookKey":"s1:ב","line":4}')).toEqual({ bookKey: "s1:ב", line: 4 });
    for (const bad of ["{", "", "null", "[]", "5", '{"bookKey":1,"line":4}', '{"bookKey":"a","line":"4"}', '{"bookKey":"a","line":-1}', '{"bookKey":"a","line":1.5}', '{"bookKey":"a"}', '{"line":1}', '{"bookKey":"a","line":1e99}'])
      expect(parseDraggedLine(bad), bad).toBeNull();
  });
});
