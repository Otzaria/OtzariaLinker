import { describe, expect, it } from "vitest";
import type { SavedDbMapping } from "../../../src/core/db-mapping";
import { parseProject, serializeProject } from "../../../src/projects/project-format";

/* The optional dbMappings field: saved mappings of non-Otzaria databases, by schema fingerprint. */
const bind = (b: { title: string }) => ({ key: `unresolved:${b.title}`, title: b.title, origin: "unknown" as const });
const base = { sources: [{ label: "corpus.db", kind: "mapped-db", books: 2 }], links: [], rejectedSuggestions: [], view: { source: null, target: null } };
const saved: SavedDbMapping = {
  fingerprint: "0123456789abcdef",
  label: "corpus.db",
  mapping: { layout: "two-tables", books: { table: "works", id: "id", title: "name" }, lines: { table: "paragraphs", book: "work_id", order: "seq", text: "body", heading: "level" }, links: { table: "connections", source: "from_line", target: "to_line" } },
};

describe("project file — database mappings", () => {
  it("round-trips the mappings", () => {
    const p = parseProject(serializeProject({ ...base, dbMappings: [saved] }, "2.0.0"), bind);
    expect(p.dbMappings).toEqual([saved]);
  });

  it("writes nothing extra when there are none, so the file stays as before", () => {
    const text = serializeProject({ ...base, dbMappings: [] }, "2.0.0", new Date(0));
    expect(text).toBe(serializeProject(base, "2.0.0", new Date(0)));
    expect(text).not.toContain("dbMappings");
    expect(JSON.parse(text).version).toBe(1); // optional field: no version bump, older readers ignore it
  });

  it("reads an older project (no field) as having no mappings", () => {
    const old = JSON.stringify({ format: "otzaria-linker-project", version: 1, savedAt: "", app: "2.0.0-alpha.0", sources: [], links: [], rejectedSuggestions: [], view: { source: null, target: null } });
    expect(parseProject(old, bind).dbMappings).toEqual([]);
  });

  it("drops damaged entries and unknown fields instead of trusting them", () => {
    const text = serializeProject(base, "2.0.0").replace(
      /}$/,
      `,"dbMappings":[${JSON.stringify({ ...saved, mapping: { ...saved.mapping, evil: 1, lines: { ...saved.mapping.lines, extra: "x" } } })},{"fingerprint":"x","label":"y","mapping":{"layout":"odd"}},5,null]}`,
    );
    const p = parseProject(text, bind);
    expect(p.dbMappings).toEqual([saved]);
  });
});
