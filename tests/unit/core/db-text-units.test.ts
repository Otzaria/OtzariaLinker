import { describe, expect, it } from "vitest";
import { jsonLines, splitLines } from "../../../src/core/db-text-units";

/* How one row's value becomes lines for the mapping wizard's text units. */
describe("splitLines", () => {
  it("splits at \n, \r\n and \r; a final break adds no empty line; empty lines inside stay", () => {
    expect(splitLines("a\nb\r\nc\rd\n")).toEqual(["a", "b", "c", "d"]);
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(splitLines("")).toEqual([""]);
  });
});

describe("jsonLines", () => {
  it("arrays of lines and of chapters, in order", () => {
    expect(jsonLines('["a","b"]')!.map((l) => l.text)).toEqual(["a", "b"]);
    expect(jsonLines('[["a","b"],["c"]]')!.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("objects: the title is a heading, then the content keys; ids and numbers are left out", () => {
    const out = jsonLines('[{"id":1,"title":"פרק א","verses":["x","y"]},{"name":"פרק ב","text":"z"}]')!;
    expect(out).toEqual([
      { text: "פרק א", heading: 2 },
      { text: "x", heading: null },
      { text: "y", heading: null },
      { text: "פרק ב", heading: 2 },
      { text: "z", heading: null },
    ]);
    expect(jsonLines('{"chapters":[{"title":"א","lines":["l1"]}]}')!.map((l) => [l.text, l.heading])).toEqual([["א", 3], ["l1", null]]);
  });

  it("not JSON, or JSON without text → null", () => {
    expect(jsonLines("שלום")).toBeNull();
    expect(jsonLines("[1,2,3]")).toBeNull();
    expect(jsonLines("[unclosed")).toBeNull();
    expect(jsonLines('{"a":1}')).toBeNull();
  });
});
