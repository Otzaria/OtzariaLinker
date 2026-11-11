import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { detectKind } from "../../../src/sources/detect";
import { parseProject, serializeProject } from "../../../src/projects/project-format";

const A: BookRef = { key: "s1:7", title: 'רש"י על בראשית', origin: "sefaria", isBaseBook: false };
const B: BookRef = { key: "s1:1", title: "בראשית", origin: "sefaria", isBaseBook: true };
const links: Link[] = [
  { id: "u:1", status: "new", provenance: "user", source: { book: A, line: 3 }, target: { book: B, line: 4, end: 6 }, declaredType: "commentary", heRef2: "בראשית א, ב", ref2: "Genesis 1:2", anchor: { rawStart: 2, rawEnd: 9 } },
  { id: "file:x:0", status: "deleted", provenance: "file", source: { book: A, line: 1 }, target: { book: B, line: 2 }, declaredType: "commentary", heRef2: "x", keyOrder: ["line_index_1"], passthrough: { anchor_src_hash: "ab" } },
  { id: "db:1", status: "existing", provenance: "db", source: { book: A, line: 1 }, target: { book: B, line: 2 }, declaredType: "commentary", heRef2: "y" },
];

describe("project file", () => {
  const text = serializeProject({ sources: [{ label: "seforim.db", kind: "otzaria-db", books: 9 }], links, rejectedSuggestions: ["headings:1"], view: { source: A.title, target: B.title } }, "2.0.0");

  it("is recognised as a project by the content detector", () => {
    expect(detectKind(new TextEncoder().encode(text).subarray(0, 4096), "work.json")).toBe("project");
  });

  it("round-trips every project link (database links are not saved) and re-binds books by title", () => {
    const keys = new Map([[A.title, "s9:70"], [B.title, "s9:10"]]);
    const p = parseProject(text, (b) => ({ ...b, key: keys.get(b.title) ?? `unresolved:${b.title}` }));
    expect(p.links.map((l) => l.id)).toEqual(["u:1", "file:x:0"]);
    expect(p.links[0]).toEqual({ ...links[0], source: { ...links[0]!.source, book: { ...A, key: "s9:70" } }, target: { ...links[0]!.target, book: { ...B, key: "s9:10" } } });
    expect(p.links[1]!.passthrough).toEqual({ anchor_src_hash: "ab" });
    expect(p.rejectedSuggestions).toEqual(["headings:1"]);
    expect(p.view).toEqual({ source: A.title, target: B.title });
    expect(p.skipped).toBe(0);
  });

  it("refuses what is not a project, and a newer version, with clear codes", () => {
    const bind = (b: { title: string }) => ({ key: b.title, title: b.title, origin: "unknown" as const });
    expect(() => parseProject("{", bind)).toThrow(expect.objectContaining({ code: "project/not-json" }));
    expect(() => parseProject("[]", bind)).toThrow(expect.objectContaining({ code: "project/not-a-project" }));
    expect(() => parseProject(text.replace('"version":1', '"version":99'), bind)).toThrow(expect.objectContaining({ code: "project/newer" }));
  });

  it("skips damaged link entries instead of failing the whole project", () => {
    const broken = text.replace('"line":3', '"line":-1');
    const p = parseProject(broken, (b) => ({ ...b, key: b.title }));
    expect(p.skipped).toBe(1);
    expect(p.links).toHaveLength(1);
  });
});

describe("project file — hostile fields (security review #9)", () => {
  const text = serializeProject({ sources: [], links: [links[0]!], rejectedSuggestions: [], view: { source: null, target: null } }, "x");
  const bind = (b: { title: string; origin: BookRef["origin"] }) => ({ key: `k:${b.title}`, title: b.title, origin: b.origin });
  it("a stored book key never overrides the session key", () => {
    const evil = text.replace('"book":{"title":"רש\\"י על בראשית"', '"book":{"key":"s1:1","title":"רש\\"י על בראשית"');
    expect(evil).not.toBe(text);
    expect(parseProject(evil, bind).links[0]!.source.book.key).toBe('k:רש"י על בראשית');
  });
  it("a malformed keyOrder skips that link instead of crashing the export later", () => {
    const evil = text.replace('"heRef2"', '"keyOrder":5,"heRef2"');
    expect(parseProject(evil, bind)).toMatchObject({ links: [], skipped: 1 });
  });
  it("unknown fields are dropped", () => {
    const evil = text.replace('"heRef2"', '"dbAnchors":[{"x":1}],"evil":1,"heRef2"');
    expect(parseProject(evil, bind).links[0]).not.toHaveProperty("evil");
  });
});

describe("project file — alt_toc (optional field of version 1)", () => {
  const bind = (b: { title: string; origin: BookRef["origin"] }) => ({ key: b.title, title: b.title, origin: b.origin });
  const altToc = [{ title: "בראשית", origin: "db" as const, structures: [{ key: "Parasha", heTitle: "פרשה", entries: [{ heTitle: "בראשית", line: 1, level: 0 }, { heTitle: "עליה א", line: 1, level: 1 }] }] }];
  const text = serializeProject({ sources: [], links: [], rejectedSuggestions: [], view: { source: null, target: null }, altToc }, "x");

  it("round-trips", () => {
    expect(JSON.parse(text).version).toBe(1);
    expect(parseProject(text, bind).altToc).toEqual(altToc);
  });
  it("is absent from a project without structures, and an older file without it still opens", () => {
    expect(serializeProject({ sources: [], links, rejectedSuggestions: [], view: { source: null, target: null } }, "x")).not.toContain("altToc");
    const old = JSON.stringify({ format: "otzaria-linker-project", version: 1, savedAt: "", app: "2.0.0-alpha.0", sources: [], links: [], rejectedSuggestions: [], view: { source: null, target: null } });
    expect(parseProject(old, bind)).toMatchObject({ altToc: [], skipped: 0 });
  });
  it("rebuilds field by field and skips damaged structures and books", () => {
    const evil = JSON.parse(text);
    evil.altToc[0].evil = 1;
    evil.altToc[0].origin = "hacker";
    evil.altToc[0].structures.push({ key: 5, entries: [] }, { key: "X", entries: [{ heTitle: "x", line: "1", level: 0 }] });
    evil.altToc.push({ title: 7, structures: [] }, { title: "בראשית", structures: [] });
    const p = parseProject(JSON.stringify(evil), bind);
    expect(p.altToc).toEqual([{ ...altToc[0], origin: "user" }]);
    expect(p.skipped).toBe(4);
  });
});
