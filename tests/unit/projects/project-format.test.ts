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

  it("keeps the status a deleted link is restored to, and only a valid one (review C1)", () => {
    const bind = (b: { title: string; origin: BookRef["origin"] }) => ({ ...b, key: b.title });
    const withStatus = (restoreStatus: unknown) => serializeProject({ sources: [], links: [{ ...links[1]!, restoreStatus } as Link], rejectedSuggestions: [], view: { source: null, target: null } }, "2.0.0");
    expect(parseProject(withStatus("existing"), bind).links[0]!.restoreStatus).toBe("existing");
    expect(parseProject(withStatus("deleted"), bind).links[0]).not.toHaveProperty("restoreStatus");
    expect(parseProject(withStatus("__proto__"), bind).links[0]).not.toHaveProperty("restoreStatus");
  });

  it("keeps the files a merged link was found in (Link.origins), and only a list of strings (V5 P1-9)", () => {
    const bind = (b: { title: string; origin: BookRef["origin"] }) => ({ ...b, key: b.title });
    const withOrigins = (origins: unknown) => serializeProject({ sources: [], links: [{ ...links[0]!, origins } as Link], rejectedSuggestions: [], view: { source: null, target: null } }, "2.0.0");
    expect(parseProject(withOrigins(["a/x_links.json", "b/x_links.json"]), bind).links[0]!.origins).toEqual(["a/x_links.json", "b/x_links.json"]);
    expect(parseProject(withOrigins([1, "a"]), bind).links[0]).not.toHaveProperty("origins");
    expect(parseProject(withOrigins("a"), bind).links[0]).not.toHaveProperty("origins");
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

describe("project file — the source's library switch (audit F2)", () => {
  const bind = (b: { title: string; origin: BookRef["origin"] }): BookRef => ({ key: `s1:${b.title}`, title: b.title, origin: b.origin });
  const sources = [
    { label: "s1", kind: "text-files", books: 2, files: ["s1/בראשית.txt"], library: true },
    { label: "אישי.db", kind: "otzaria-db", books: 3, library: false },
    { label: "seforim.db", kind: "otzaria-db", books: 9 },
  ];

  it("round-trips as an optional field of version 1", () => {
    const text = serializeProject({ sources, links: [], rejectedSuggestions: [], view: { source: null, target: null } }, "x");
    expect(JSON.parse(text).version).toBe(1);
    expect(parseProject(text, bind).sources).toEqual(sources);
  });

  it("an older project without it opens with no choice; a value that is not true/false is dropped", () => {
    const old = JSON.stringify({ format: "otzaria-linker-project", version: 1, savedAt: "", app: "3.0.0", sources: [{ label: "s1", kind: "text-files", books: 2 }], links: [], rejectedSuggestions: [], view: { source: null, target: null } });
    expect(parseProject(old, bind).sources).toEqual([{ label: "s1", kind: "text-files", books: 2 }]);
    const odd = old.replace('"books":2', '"books":2,"library":"yes"');
    expect(parseProject(odd, bind).sources[0]).not.toHaveProperty("library");
  });
});

describe("project file — the coverage of the books (2.15)", () => {
  const bind = (b: { title: string; origin: BookRef["origin"] }) => ({ ...b, key: `unresolved:${b.title}` });
  const base = { sources: [], links: [], rejectedSuggestions: [], view: { source: null, target: null } };
  const entry = { title: B.title, lines: 100, buckets: { linked: 60, unlinked: 30, "not-suitable": 10 }, ranges: [[3, 9], [40, 41]] as [number, number][], at: 1_700_000_000_000 };

  it("round-trips as an optional field of version 1 (no version bump); an older project has none", () => {
    const text = serializeProject({ ...base, coverage: [entry] }, "4.0.0");
    expect(JSON.parse(text).version).toBe(1);
    expect(parseProject(text, bind).coverage).toEqual([entry]);
    expect(JSON.parse(serializeProject(base, "4.0.0"))).not.toHaveProperty("coverage");
    expect(parseProject(serializeProject(base, "4.0.0"), bind).coverage).toEqual([]);
  });

  it("is untrusted input: unknown buckets, negative or fractional counts, ranges outside the book and repeated titles are dropped", () => {
    const raw = JSON.parse(serializeProject(base, "4.0.0"));
    raw.coverage = [
      { ...entry, buckets: { linked: 5, bogus: 3, unlinked: -1, partial: 1.5 }, ranges: [[3, 9], [9, 3], [50, 500], ["a", 1], [1]] },
      { ...entry, title: "" },
      { ...entry, title: "ג" },
      { ...entry },
      null,
      "x",
      { ...entry, title: "ב", lines: -2 },
    ];
    const got = parseProject(JSON.stringify(raw), bind).coverage;
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({ title: B.title, lines: 100, buckets: { linked: 5 }, ranges: [[3, 9]], at: entry.at });
    raw.coverage = { title: "א" };
    expect(parseProject(JSON.stringify(raw), bind).coverage).toEqual([]);
  });
});

describe("project file — the books' line counts (V5 P1-10)", () => {
  const bind = (b: { title: string; origin: BookRef["origin"] }) => ({ ...b, key: `unresolved:${b.title}` });
  const base = { sources: [], links: [], rejectedSuggestions: [], view: { source: null, target: null } };

  it("round-trips as an optional field of version 1; an older project has none", () => {
    const text = serializeProject({ ...base, bookLines: [{ title: B.title, lines: 1533 }] }, "4.0.0");
    expect(parseProject(text, bind).bookLines).toEqual([{ title: B.title, lines: 1533 }]);
    expect(JSON.parse(serializeProject(base, "4.0.0"))).not.toHaveProperty("bookLines");
    expect(parseProject(serializeProject(base, "4.0.0"), bind).bookLines).toEqual([]);
  });

  it("is untrusted input: entries that are not a title and a whole count are dropped, a repeated title is kept once", () => {
    const raw = JSON.parse(serializeProject(base, "4.0.0"));
    raw.bookLines = [{ title: "א", lines: 3 }, { title: "א", lines: 9 }, { title: "", lines: 1 }, { title: "ב", lines: -1 }, { title: "ג", lines: 1.5 }, { title: 7, lines: 2 }, null, "x", { title: "__proto__", lines: 4 }];
    expect(parseProject(JSON.stringify(raw), bind).bookLines).toEqual([{ title: "א", lines: 3 }, { title: "__proto__", lines: 4 }]);
    raw.bookLines = { title: "א", lines: 3 };
    expect(parseProject(JSON.stringify(raw), bind).bookLines).toEqual([]);
  });

  // V7 §1.1 (items 4, 6): by title only, two books of one title shared one entry — the second book's count was lost and the
  // first's applied to both. An entry is now per book: title, origin, source and edition (all optional for older files).
  it("is kept per book: two books of one title are two entries, each with its origin, source and edition", () => {
    const two = [
      { title: "ספר", lines: 4, origin: "personal" as const, source: "a.db", edition: "4:0123456789abcdef" },
      { title: "ספר", lines: 9, origin: "personal" as const, source: "b.db", edition: "9:fedcba9876543210" },
      { title: "ספר", lines: 4, origin: "personal" as const, source: "user_books.db", edition: "4:1111111111111111" },
      { title: "ספר", lines: 4, origin: "personal" as const, source: "user_books.db", edition: "4:2222222222222222" },
    ];
    expect(parseProject(serializeProject({ ...base, bookLines: two }, "4.0.0"), bind).bookLines).toEqual(two);
    const raw = JSON.parse(serializeProject(base, "4.0.0"));
    // untrusted: an origin that is not one, a source without an origin, an edition that is not one are dropped
    raw.bookLines = [{ title: "ספר", lines: 2, origin: "x", source: "a.db", edition: "<script>" }, { title: "ספר", lines: 2, origin: "otzaria", edition: "2:zz" }];
    expect(parseProject(JSON.stringify(raw), bind).bookLines).toEqual([{ title: "ספר", lines: 2 }, { title: "ספר", lines: 2, origin: "otzaria" }]);
  });

  it("a book's edition goes with a link only when the project names it (StoredBook.edition), and comes back on the unresolved book", () => {
    const X: BookRef = { key: "s1:11", title: "ספר", origin: "personal" };
    const link = (id: string, book: BookRef) => ({ id, status: "new" as const, provenance: "user" as const, source: { book: B, line: 1 }, target: { book, line: 2 }, declaredType: "reference", heRef2: "x" });
    const text = serializeProject({ ...base, links: [link("a", X), link("b", { ...X, key: "s2:11" })], sourceOf: () => "user_books.db", editionOf: (k) => (k === "s2:11" ? "4:2222222222222222" : undefined) }, "4.0.0");
    const stored = JSON.parse(text).links.map((l: { target: { book: unknown } }) => l.target.book);
    expect(stored).toEqual([
      { title: "ספר", origin: "personal", source: "user_books.db" },
      { title: "ספר", origin: "personal", source: "user_books.db", edition: "4:2222222222222222" },
    ]);
    const back = parseProject(text, (b) => ({ ...b, key: `unresolved:${b.title}` })).links.map((l) => l.target.book);
    expect(back[1]).toMatchObject({ source: "user_books.db", edition: "4:2222222222222222" });
    expect(back[0]).not.toHaveProperty("edition");
  });
});
