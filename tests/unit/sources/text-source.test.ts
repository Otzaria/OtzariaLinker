import { describe, expect, it } from "vitest";
import { splitBookLines, TextFilesSource, type TextFile } from "../../../src/sources/text/text-source";

const file = (path: string, text: string | Uint8Array): TextFile => ({ path, read: async () => (typeof text === "string" ? new TextEncoder().encode(text) : text) });

describe("splitBookLines — exactly the generator's exactLineSequence", () => {
  it.each([
    ["", [""]],
    ["א", ["א"]],
    ["א\n", ["א", ""]],
    ["א\r\nב", ["א", "ב"]],
    ["א\rב\r", ["א", "ב", ""]],
    ["א\n\nב", ["א", "", "ב"]],
    ["﻿א\nב", ["א", "ב"]],
  ])("%j", (input, expected) => expect(splitBookLines(input)).toEqual(expected));
});

describe("TextFilesSource", () => {
  const src = new TextFilesSource("t", "תיקייה", [
    file("ספרים/רש\"י על בראשית.txt", "<h1>רש״י</h1>\n<h2></h2>\nפירוש\n <h2>לא כותרת</h2>"),
    file("אחר/רש״י על בראשית.txt", "x"),
    file("ישן.txt", new Uint8Array([0xf9, 0xec, 0xe5, 0xed])),
  ]);
  it("titles follow the generator's normalization; a clash is warned about", async () => {
    const books = await src.books();
    expect(books.map((b) => b.title)).toEqual(["רש״י על בראשית", "רש״י על בראשית", "ישן"]);
    expect(src.info.warnings.map((w) => w.code)).toContain("source/duplicate-title");
  });
  it("lines: headings by prefix, an empty heading does not exist in the database", async () => {
    const lines = await src.lines('t:ספרים/רש"י על בראשית.txt');
    expect(lines.map((l) => [l.heading, l.existsInDb])).toEqual([[1, true], [2, false], [null, true], [null, true]]);
    expect((await src.lines('t:ספרים/רש"י על בראשית.txt', 2, 2)).map((l) => l.text)).toEqual(["פירוש"]);
  });
  it("a non-UTF-8 book is read, with a warning that the library needs UTF-8", async () => {
    expect((await src.lines("t:ישן.txt"))[0]!.text).toBe("שלום");
    expect(src.info.warnings.map((w) => w.code)).toContain("source/not-utf8");
  });
});
