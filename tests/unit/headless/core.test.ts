import { describe, expect, it } from "vitest";
import { createLinkerCore, CORE_API_VERSION } from "../../../src/headless/core";
import { otzariaAdapters, otzariaBookKey } from "../../../src/headless/otzaria-host";
import { parseLinksJson } from "../../../src/formats/links-json/parse";
import { suggestionLinks } from "../../../src/linking/approve";
import { otzariaSim } from "../../support/otzaria-sim";
import { pairTexts } from "./fixture-books";

/*
 * The headless core's own API (docs/PLUGIN_READINESS.md §2a): approval is the app's (linking/approve.ts), the host's existing
 * links mark suggestions "exists" and are never approved again, and the export is planExport's — a `_links.json` that parses back
 * to the same records.
 */
const { base, comm } = pairTexts(120);
const B = "בסיס";
const C = "פירוש על בסיס";

function core(links: Record<string, unknown>[] = []) {
  const s = otzariaSim({ books: [{ bookId: B, lines: base }, { bookId: C, lines: comm, links }] });
  return { s, core: createLinkerCore(otzariaAdapters(s.call, { books: [C, B], sleep: async (ms) => s.advance(ms) })) };
}

describe("the headless core", () => {
  it("lists its engines and version", () => {
    const { core: c } = core();
    expect(c.version).toBe(CORE_API_VERSION);
    expect(c.engines().map((e) => e.id)).toEqual(expect.arrayContaining(["headings", "dibur-hamatchil", "footnotes", "citations"]));
    expect(c.engines().find((e) => e.id === "citations")!.kind).toBe("single");
  });

  it("runPair refuses a single-book engine", async () => {
    const { core: c } = core();
    await expect(c.runPair("citations", otzariaBookKey(C), otzariaBookKey(B))).rejects.toThrow(/not a pair engine/);
  });

  it("approve: the app's links (auto:<id>), only at or above the chosen confidence, never what the host has", async () => {
    const { core: c } = core();
    const run = await c.runPair("dibur-hamatchil", otzariaBookKey(C), otzariaBookKey(B));
    const certain = c.approve(run);
    expect(certain.length).toBeGreaterThan(50);
    expect(certain.every((l) => l.id.startsWith("auto:") && l.status === "new" && l.provenance === "auto")).toBe(true);
    const first = run.result.suggestions.find((s) => s.confidence === "certain")!;
    expect(certain).toContainEqual(suggestionLinks(first)[0]);
    expect(c.approve(run, { minConfidence: "possible" }).length).toBeGreaterThanOrEqual(certain.length);
    expect(c.approve(run, { ids: [first.id] })).toHaveLength(1);
    // what another engine's run already chose is not written twice
    expect(c.approve(run, { already: certain })).toEqual([]);
  });

  it("a suggestion whose two lines the host already links is marked exists and not approved", async () => {
    const probe = core();
    const run0 = await probe.core.runPair("dibur-hamatchil", otzariaBookKey(C), otzariaBookKey(B));
    const s0 = run0.result.suggestions.find((s) => s.confidence === "certain")!;
    const l0 = suggestionLinks(s0)[0]!;
    // the host's link between the same two lines, in the other direction and another type (equality: "same lines")
    const from = l0.source.book.title === C ? l0.source : l0.target;
    const to = from === l0.source ? l0.target : l0.source;
    const hostLink = { line_index_1: from.line + 1, line_index_2: to.line + 1, heRef_2: "x", path_2: B, "Conection Type": "COMMENTARY" };
    const { core: c } = core([hostLink]);
    const run = await c.runPair("dibur-hamatchil", otzariaBookKey(C), otzariaBookKey(B));
    expect(run.exists.has(s0.id)).toBe(true);
    expect(c.approve(run).some((l) => l.id === l0.id)).toBe(false);
  });

  it("exportFiles writes a _links.json that parses back to the approved links, and save hands it to the private space", async () => {
    const { s, core: c } = core();
    const run = await c.runPair("dibur-hamatchil", otzariaBookKey(C), otzariaBookKey(B));
    const links = c.approve(run);
    const plan = await c.exportFiles(links);
    expect(plan.heldBack).toEqual([]);
    expect(plan.files).toHaveLength(1);
    const parsed = parseLinksJson(plan.files[0]!.text);
    expect(parsed.records).toHaveLength(links.length);
    expect(parsed.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(await c.save(plan)).toEqual([plan.files[0]!.name]);
    expect(s.files.get(`linker/${plan.files[0]!.name}`)).toBe(plan.files[0]!.text);
  });
});
