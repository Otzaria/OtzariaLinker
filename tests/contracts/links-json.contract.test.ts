import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BookRef } from "../../src/core/links/model";
import { storedForm } from "../../src/core/links/stored-form";
import { isMergeableCompanionTitle, titleFromPath2 } from "../../src/core/links/titles";
import { linkToRecord, recordToLink } from "../../src/formats/links-json/convert";
import { parseLinksJson } from "../../src/formats/links-json/parse";
import { serializeLinksJson } from "../../src/formats/links-json/serialize";

/*
 * Contract tests against REAL library records and the rows the real generator produced from them
 * (tests/fixtures/contracts, otzaria-library@17eb3cc5 → seforim.db v37, schema 7).
 */
interface Example {
  shape: string;
  file: string;
  record: Record<string, unknown>;
  resolution: {
    status: string;
    sourceTitle: string;
    targetTitle: string;
    sourceBook?: { id: number; source: string; isBaseBook: number } | [];
    targetBook?: { id: number; source: string; isBaseBook: number } | [];
  };
  dbRows?: { link: { connectionType: string; storedDirection: "as_file" | "flipped" }; link_range: { side: number }[] }[];
}

const DIR = resolve("tests/fixtures/contracts");
const load = (f: string) => (JSON.parse(readFileSync(join(DIR, f), "utf8")) as { examples: Example[] }).examples;
// The single live downgrade example carries only dbRows; its books are known from them:
// source = MoreBooks book 6043 (not a base book), target = book 1 בראשית (Sefaria, base book).
const downgrade = load("dependent-downgraded-to-other.json").map((e): Example => ({
  ...e,
  shape: "L->L downgraded",
  resolution: {
    status: "matched",
    sourceTitle: e.file.split("/").at(-1)!.replace(/_links\.json$/, ""),
    targetTitle: titleFromPath2(String(e.record.path_2)),
    sourceBook: { id: 6043, source: "MoreBooks", isBaseBook: 0 },
    targetBook: { id: 1, source: "Sefaria", isBaseBook: 1 },
  },
}));
const examples: [string, Example][] = [
  ...readdirSync(DIR)
    .filter((f) => f.endsWith(".json") && !["db-only-shapes.json", "dependent-downgraded-to-other.json"].includes(f))
    .flatMap((f) => load(f).map((e) => [`${f} ${e.shape} ${e.resolution.sourceTitle}`, e] as [string, Example])),
  ...downgrade.map((e) => [`downgrade ${e.resolution.sourceTitle}`, e] as [string, Example]),
];

const bookOf = (title: string, raw?: { id: number; source: string; isBaseBook: number } | []): BookRef => {
  const b = Array.isArray(raw) ? undefined : raw;
  return {
    key: b ? `db:${b.id}` : `unresolved:${title}`,
    title,
    origin: !b ? "unknown" : /sefaria/i.test(b.source) ? "sefaria" : "otzaria",
    isBaseBook: b ? b.isBaseBook === 1 : undefined,
  };
};

function toLink(e: Example) {
  const { records, issues } = parseLinksJson(JSON.stringify([e.record]));
  expect(issues.filter((i) => i.level === "error")).toEqual([]);
  const source = bookOf(e.resolution.sourceTitle, e.resolution.sourceBook);
  const target = bookOf(e.resolution.targetTitle, e.resolution.targetBook);
  return recordToLink(records[0]!, 0, source, (t) => (t === target.title ? target : null), "L1").link;
}

describe("contract: stored form matches what the generator wrote to seforim.db", () => {
  const matched = examples.filter(([, e]) => e.resolution.status === "matched" && e.dbRows?.length);
  it("has a meaningful number of real examples", () => expect(matched.length).toBeGreaterThan(40));

  it.each(matched)("%s", (_, e) => {
    const f = storedForm(toLink(e));
    expect(f.skipped).toBeNull();
    const rows = e.dbRows!.filter((r) => r.link.connectionType !== "LINKER");
    const row = rows.find((r) => r.link.connectionType === f.stored && (r.link.storedDirection === "flipped") === f.flipped);
    expect(row, `predicted ${f.stored}${f.flipped ? " flipped" : ""}; db has ${rows.map((r) => r.link.connectionType + "/" + r.link.storedDirection).join(", ")}`).toBeDefined();
    // range side follows the STORED direction
    const fileSourceRange = e.record.line_index_1_end !== undefined;
    const fileTargetRange = e.record.line_index_2_end !== undefined;
    const expectedSides = new Set<number>([
      ...(fileSourceRange ? [f.flipped ? 1 : 0] : []),
      ...(fileTargetRange ? [f.flipped ? 0 : 1] : []),
    ]);
    for (const r of row!.link_range) expect(expectedSides.has(r.side)).toBe(true);
  });
});

describe("contract: records that never become a link", () => {
  it("a target named 'הערות על …' is a mergeable companion", () => {
    const notes = examples.filter(([n]) => n.startsWith("notes-companion")).map(([, e]) => titleFromPath2(String(e.record.path_2)));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.filter(isMergeableCompanionTitle).length).toBeGreaterThan(0);
  });
});

describe("contract: lossless round-trip of real records", () => {
  // Values and key order survive exactly. Number spelling does not: "981.0" comes back as "981"
  // (JSON.parse cannot keep it); the generator and the pipeline read both the same.
  it.each(examples)("%s", (_, e) => {
    const out = serializeLinksJson([linkToRecord(toLink(e))]);
    expect(out).toBe(JSON.stringify([JSON.parse(JSON.stringify(e.record))], null, 2));
  });
});
