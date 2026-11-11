import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";

const DB = new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]);
const txt = (s: string) => new Blob([strToU8(s)]);
const LINKS = JSON.stringify([{ line_index_1: 2, heRef_2: "בראשית א, א", path_2: "בראשית.txt", line_index_2: 3, "Conection Type": "commentary" }]);

describe("SourceRegistry — files are classified by content, not by name", () => {
  it("a database, loose text files and a links file in one drop", async () => {
    const r = new SourceRegistry();
    const res = await r.open([
      { path: "renamed.bin", blob: DB },
      { path: "ספרים/פירוש א.txt", blob: txt("<h1>פירוש א</h1>\nשורה") },
      { path: "ספרים/פירוש ב.txt", blob: txt("שורה") },
      { path: "פירוש א_links.json", blob: txt(LINKS) },
    ]);
    expect(res.sources.map((s) => s.info.kind)).toEqual(["otzaria-db", "text-files"]);
    expect(res.sources[1]!.info.label).toBe("ספרים");
    expect(res.sources[1]!.books.map((b) => b.title)).toEqual(["פירוש א", "פירוש ב"]);
    expect(res.documents).toEqual([{ path: "פירוש א_links.json", kind: "links-json", text: LINKS }]);
    expect(res.skipped).toEqual([]);

    const bereshit = res.sources[0]!.books.find((b) => b.title === "בראשית")!;
    const lines = await r.lines(bereshit.key, 0, 2);
    expect(lines.map((l) => l.index)).toEqual([0, 1, 2]);
    expect((await r.lines(res.sources[1]!.books[0]!.key, 0, 9)).map((l) => l.heading)).toEqual([1, null]);
  });

  it("a ZIP yields a text source and its links files; unsafe entries never escape", async () => {
    const zip = zipSync({ "lib/x.txt": strToU8("א\nב"), "lib/x_links.json": strToU8(LINKS), "notes.md": strToU8("#") });
    const r = new SourceRegistry();
    const res = await r.open([{ path: "lib.zip", blob: new Blob([zip]) }]);
    expect(res.sources[0]!.info.label).toBe("lib.zip");
    expect(res.sources[0]!.books.map((b) => b.title)).toEqual(["x"]);
    expect(res.documents.map((d) => d.path)).toEqual(["lib.zip/lib/x_links.json"]);
  });

  it("explains every file it does not open", async () => {
    const r = new SourceRegistry();
    const res = await r.open([
      { path: "a.json", blob: txt('{"x":1}') },
      { path: "a.csv", blob: txt("a,b\n1,2") },
      { path: "a.png", blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])]) },
      { path: "broken.zip", blob: new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])]) },
    ]);
    expect(res.sources).toEqual([]);
    expect(res.skipped.map((s) => s.path)).toEqual(["a.json", "a.csv", "a.png", "broken.zip"]);
    for (const s of res.skipped) expect(s.reason.length).toBeGreaterThan(10);
  });

  it("a closed source refuses further reads with a clear code", async () => {
    const r = new SourceRegistry();
    const res = await r.open([{ path: "x.txt", blob: txt("א") }]);
    r.close(res.sources[0]!.info.id);
    await expect(r.lines(res.sources[0]!.books[0]!.key, 0, 0)).rejects.toMatchObject({ code: "source/closed" });
  });
});
