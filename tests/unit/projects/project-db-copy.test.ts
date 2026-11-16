import { describe, expect, it } from "vitest";
import type { Link } from "../../../src/core/links/model";
import { parseProject, serializeProject } from "../../../src/projects/project-format";

/* Links copied from a database ("db-copy") are the user's work: saved and read back; "db" links never are. */
const bind = (b: { title: string }) => ({ key: `unresolved:${b.title}`, title: b.title, origin: "unknown" as const });
const book = { key: "s1:8050", title: "ארצות החיים", origin: "otzaria" as const, isBaseBook: false };
const other = { key: "s1:8051", title: "המאיר לארץ על ארצות החיים", origin: "otzaria" as const, isBaseBook: false };
const copy: Link = { id: "c:1", status: "new", provenance: "db-copy", source: { book, line: 322 }, target: { book: other, line: 1306 }, declaredType: "commentary", heRef2: "המאיר לארץ על ארצות החיים 1307", anchor: { rawStart: 33 } };
const db: Link = { ...copy, id: "s1:link:13469515", status: "existing", provenance: "db" };

describe("project file — copied database links", () => {
  it("keeps a copy with its provenance and drops the database link itself", () => {
    const p = parseProject(serializeProject({ sources: [], links: [copy, db], rejectedSuggestions: [], view: { source: null, target: null } }, "2.0.0"), bind);
    expect(p.links).toHaveLength(1);
    expect(p.links[0]).toMatchObject({ id: "c:1", provenance: "db-copy", status: "new", source: { line: 322 }, target: { line: 1306 }, anchor: { rawStart: 33 } });
  });
});
