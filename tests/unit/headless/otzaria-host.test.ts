import { describe, expect, it } from "vitest";
import { LinkerError } from "../../../src/core/errors";
import { createLinkerCore } from "../../../src/headless/core";
import { otzariaAdapters, otzariaBookKey, otzariaBooks, otzariaLinks, otzariaSave, SDK_LIMITS } from "../../../src/headless/otzaria-host";
import { runEngine, type EngineId } from "../../../src/linking/automatic";
import { otzariaSim } from "../../support/otzaria-sim";
import { asEngineBook, pairTexts } from "./fixture-books";

/*
 * The headless core over a simulated `Otzaria.call` (tests/support/otzaria-sim.ts, which keeps the SDK's documented limits): the
 * ports read the books in windows the SDK allows, the existing links come back as the model's links, a rate-limited call waits and
 * goes on, a refused permission is said in Hebrew, and the engines give exactly what runEngine gives on the same lines.
 */
const { base, comm } = pairTexts(400);
const BASE_ID = "בסיס";
const COMM_ID = "פירוש על בסיס";
const sim = (extra: Partial<Parameters<typeof otzariaSim>[0]> = {}) =>
  otzariaSim({ books: [{ bookId: BASE_ID, lines: base }, { bookId: COMM_ID, lines: comm }], ...extra });
const opts = (s: ReturnType<typeof sim>) => ({ books: [COMM_ID, BASE_ID], sleep: async (ms: number) => s.advance(ms) });

describe("the Otzaria ports (SDK 1.x, simulated host)", () => {
  it("reads a book in getBookContent windows of at most 5,000 characters, and its lines are the book's lines", async () => {
    const s = sim();
    const books = otzariaBooks(s.call, opts(s));
    const lines = await books.lines(otzariaBookKey(BASE_ID), 0, Number.MAX_SAFE_INTEGER);
    expect(lines.map((l) => l.text)).toEqual(base);
    expect(lines[0]).toMatchObject({ index: 0, heading: 2, heRef: null, existsInDb: true });
    const reads = s.log.filter((c) => c.method === "library.getBookContent");
    expect(reads.length).toBe(Math.ceil(base.join("\n").length / SDK_LIMITS.contentChars) + 1); // the last one is empty: the end
    expect(reads.every((c) => c.payload.limit === 5000 && c.payload.rawDivineNames === true)).toBe(true);
    // a second window of the same book comes from memory
    await books.lines(otzariaBookKey(BASE_ID), 100, 199);
    expect(s.log.filter((c) => c.method === "library.getBookContent").length).toBe(reads.length);
  });

  it.each<EngineId>(["headings", "dibur-hamatchil"])("%s through the Otzaria ports gives exactly what runEngine gives on the same lines", async (engine) => {
    const s = sim();
    const core = createLinkerCore(otzariaAdapters(s.call, opts(s)));
    const run = await core.runPair(engine, otzariaBookKey(COMM_ID), otzariaBookKey(BASE_ID));
    const direct = runEngine(engine, asEngineBook(run.source, comm), asEngineBook(run.target, base));
    expect(run.result.suggestions.length).toBeGreaterThan(300);
    expect(run.result).toEqual(direct);
  });

  it("getRawLinks: windows of at most 1,000 lines, a truncated window read again smaller, 1-based records become 0-based db links", async () => {
    const long = Array.from({ length: 2500 }, (_, i) => `שורה ${i}`);
    const links = Array.from({ length: 30 }, (_, i) => ({ line_index_1: 1 + i * 80, line_index_2: 2, heRef_2: "בסיס 2", path_2: BASE_ID, "Conection Type": "COMMENTARY" }));
    const s = otzariaSim({ books: [{ bookId: "ארוך", lines: long, links }, { bookId: BASE_ID, lines: base }], maxRawLinks: 8 });
    const o = { books: ["ארוך", BASE_ID], sleep: async (ms: number) => s.advance(ms) };
    const got = await otzariaLinks(s.call, otzariaBooks(s.call, o), o).existing(otzariaBookKey("ארוך"));
    const windows = s.log.filter((c) => c.method === "library.getRawLinks").map((c) => Number(c.payload.endLine) - Number(c.payload.startLine) + 1);
    expect(Math.max(...windows)).toBeLessThanOrEqual(1000);
    expect(windows).toContain(1000); // tried whole, then smaller after a truncated answer
    expect(got).toHaveLength(30);
    expect(got[1]).toMatchObject({ provenance: "db", source: { line: 80, book: { title: "ארוך" } }, target: { line: 1, book: { key: otzariaBookKey(BASE_ID) } }, declaredType: "COMMENTARY" });
  });

  it("a rate-limited burst waits for the bucket and goes on (getBookMetadata is not exempt)", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ bookId: `ספר ${i}`, lines: ["א"] }));
    const s = otzariaSim({ books: many });
    const list = await otzariaBooks(s.call, { books: many.map((b) => b.bookId), sleep: async (ms) => s.advance(ms) }).list();
    expect(list).toHaveLength(80);
    expect(s.now()).toBeGreaterThan(0); // it had to wait
  });

  it("getBookContent is exempt from the limiter only when its permission is granted; a refused permission is a Hebrew LinkerError", async () => {
    const s = sim({ granted: ["library.books.read"] });
    const books = otzariaBooks(s.call, opts(s));
    const err = await books.lines(otzariaBookKey(BASE_ID), 0, 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkerError);
    expect((err as LinkerError).code).toBe("plugin/host-error");
    expect((err as LinkerError).message).toMatch(/הרשאה/);
    expect((err as LinkerError).details).toMatchObject({ code: "error.permission_denied", method: "library.getBookContent" });
  });

  it("saves only into the plugin's private space, never a path, never more than 10 MB a call", async () => {
    const s = sim();
    const save = otzariaSave(s.call, { books: [] });
    await save.save({ name: "פירוש על בסיס_links.json", mimeType: "application/json", content: "[]" });
    expect([...s.files.keys()]).toEqual(["linker/פירוש על בסיס_links.json"]);
    await expect(save.save({ name: "../x_links.json", mimeType: "application/json", content: "[]" })).rejects.toMatchObject({ code: "plugin/bad-file-name" });
    await expect(save.save({ name: "big.json", mimeType: "application/json", content: "א".repeat(6 * 1024 * 1024) })).rejects.toMatchObject({ code: "plugin/file-too-large" });
    await save.save({ name: "a.zip", mimeType: "application/zip", content: new Uint8Array([1, 2, 3, 250]) });
    expect(s.files.get("linker/a.zip")).toBe(Buffer.from([1, 2, 3, 250]).toString("base64"));
  });

  it("calls nothing that writes the library: every method used is a read, or fs in the private space", async () => {
    const s = sim();
    const core = createLinkerCore(otzariaAdapters(s.call, opts(s)));
    const run = await core.runPair("dibur-hamatchil", otzariaBookKey(COMM_ID), otzariaBookKey(BASE_ID));
    await core.save(await core.exportFiles(core.approve(run)));
    const methods = new Set(s.log.map((c) => c.method));
    expect([...methods].sort()).toEqual(["fs.writeFile", "library.getBookContent", "library.getBookMetadata", "library.getRawLinks"]);
  });
});
