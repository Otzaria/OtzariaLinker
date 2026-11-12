import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceBook } from "../../src/core/books";
import type { BookRef, Link } from "../../src/core/links/model";
import type { LineFacts, ValidationContext } from "../../src/core/links/validate";
import { sourceTitleFromLinksFileName, titleFromPath2 } from "../../src/core/links/titles";
import { decodeText } from "../../src/core/text/decode";
import { recordToLink } from "../../src/formats/links-json/convert";
import { planExport } from "../../src/formats/links-json/export";
import { detectLayout } from "../../src/formats/links-json/layout";
import { parseLinksJson } from "../../src/formats/links-json/parse";
import { runQa } from "../../src/linking/qa";
import { SourceRegistry } from "../../src/sources/registry";
import { cleanupTmp, DB, fileBlob, fingerprint, gitBlobs, gitFiles, gitHead, LIBRARY, ms, oracle, record, tally, tmpDir, type GitFile } from "./env";

/*
 * Check 3 — every `_links.json` of the library clone, as committed (HEAD; see gitFiles in env.ts):
 *   • parse → model → export (the tool's own import and export path) and compare BYTE FOR BYTE with
 *     the original; every difference is classified (BOM, CRLF, final newline, layout, key order, loss);
 *   • with OTZARIA_DB: the QA/export verdicts (runQa = validateExport) against the database's books,
 *     with line facts read through the tool for the live roots (manual_links_sync.json links_roots);
 *   • with OTZARIA_DB: ground truth for the live roots — did the generator actually store each record?
 *     (scripts/validation/db_oracle.py presence). An error on a record the database HAS is a false
 *     alarm; a clean record the database LACKS is a missed problem (or drift since the clone's commit).
 *
 *   OTZARIA_LIBRARY=C:/…/otzaria-library OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db \
 *     npx vitest run --config vitest.validation.config.ts tests/validation/library-links.test.ts
 */
const PRESENCE_PER_FILE = 400; // records per file checked against the database (evenly spaced)

interface FileResult {
  path: string;
  live: boolean;
  records: number;
  roundTrip: string;
  detail?: string;
  rejectsFile: boolean;
}

describe.runIf(LIBRARY)("check 3: every _links.json of the library", () => {
  const before = DB ? fingerprint(DB) : "";
  let files: GitFile[];
  let liveRoots: string[];
  let registry: SourceRegistry | null = null;
  const byTitle = new Map<string, SourceBook>();
  const byKey = new Map<string, SourceBook>();
  const facts = new Map<string, { heading: Int8Array; exists: Uint8Array; anchorLength: Int32Array; notes: Uint8Array }>();

  beforeAll(async () => {
    files = gitFiles(LIBRARY!, (p) => p.endsWith("_links.json"));
    const sync = JSON.parse(readFileSync(join(LIBRARY!, "manual_links_sync.json"), "utf8")) as { links_roots: { path: string; expected_state: string }[] };
    liveRoots = sync.links_roots.filter((r) => r.expected_state === "present").map((r) => r.path.replaceAll("\\", "/"));
    if (DB) {
      registry = new SourceRegistry();
      const opened = await registry.open([{ path: "seforim.db", blob: await fileBlob(DB) }]);
      for (const b of opened.sources[0]!.books) {
        byKey.set(b.key, b);
        if (!byTitle.has(b.title)) byTitle.set(b.title, b);
      }
    }
  });
  afterAll(() => {
    cleanupTmp();
    if (DB) expect(fingerprint(DB)).toBe(before);
  });

  const refOf = (b: SourceBook): BookRef => ({ key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) });
  // the store's resolveTitle: exact title, then the title path_2 would give
  const resolve = (t: string): BookRef | null => {
    const b = byTitle.get(t) ?? byTitle.get(titleFromPath2(t));
    return b ? refOf(b) : null;
  };
  const ctx = (withLines: boolean): ValidationContext => ({
    lineCount: (ref) => byTitle.get(ref.title)?.lineCount,
    line: (ref, i): LineFacts | undefined => {
      if (!withLines) return undefined;
      const f = facts.get(ref.key);
      if (!f || i < 0 || i >= f.exists.length) return undefined;
      return { exists: f.exists[i] === 1, heading: f.heading[i]! > 0 ? f.heading[i]! : null, anchorLength: f.anchorLength[i]!, hasNotes: f.notes[i] === 1 };
    },
  });

  async function loadFacts(keys: Iterable<string>): Promise<void> {
    for (const key of keys) {
      if (facts.has(key) || !registry) continue;
      const n = byKey.get(key)?.lineCount ?? 0;
      const f = { heading: new Int8Array(n), exists: new Uint8Array(n), anchorLength: new Int32Array(n), notes: new Uint8Array(n) };
      for await (const c of registry.scan(key, 2000))
        for (const l of c.lines) {
          f.heading[l.index] = l.heading ?? 0;
          f.exists[l.index] = l.existsInDb ? 1 : 0;
          f.anchorLength[l.index] = l.anchorText.length;
          f.notes[l.index] = l.anchorText !== l.text || l.text.includes('class="footnote"') ? 1 : 0;
        }
      facts.set(key, f);
    }
  }

  it("parses, re-exports byte for byte, and checks every file", async () => {
    const t0 = performance.now();
    const results: FileResult[] = [];
    const issues: { code: string; level: string; live: boolean; example: string }[] = [];
    const presenceQueries: string[] = [];
    const recordVerdict = new Map<string, { codes: string[]; level: "error" | "warning" | "clean"; type: string; ref: boolean }>();
    let records = 0;
    let liveRecords = 0;

    for (const [file, bytes] of gitBlobs(LIBRARY!, files)) {
      const rel = file.path;
      const path = rel;
      const live = liveRoots.some((r) => rel.startsWith(`${r}/`));
      const text = decodeText(bytes).text; // exactly what SourceRegistry hands to the store
      const parsed = parseLinksJson(text);
      const sourceTitle = sourceTitleFromLinksFileName(path)!;
      const sourceRef = resolve(sourceTitle) ?? { key: `unresolved:${sourceTitle}`, title: sourceTitle, origin: "unknown" as const };
      const links: Link[] = [];
      parsed.records.forEach((r, i) => {
        const { link, issues: more } = recordToLink(r, i, sourceRef, resolve, `file:${rel}:${i}`);
        links.push(link);
        for (const x of more) if (x.code !== "record/target-not-found" || !DB) issues.push({ code: x.code, level: x.level, live, example: `${rel} #${i + 1}` });
      });
      for (const x of parsed.issues) issues.push({ code: x.code, level: x.level, live, example: `${rel}${x.index >= 0 ? ` #${x.index + 1}` : ""}` });
      records += links.length;
      if (live) liveRecords += links.length;

      // verdicts: QA = export rules, against the database's books (line facts only for the live roots)
      if (DB) {
        if (live) await loadFacts(new Set(links.flatMap((l) => [l.source.book.key, l.target.book.key]).filter((k) => !k.startsWith("unresolved:"))));
        const qa = runQa(links, ctx(live));
        const perLink = new Map<string, string[]>();
        for (const q of qa.issues) {
          if (q.problem.code === "export/line-not-verified") continue;
          issues.push({ code: q.problem.code, level: q.problem.severity, live, example: `${rel} #${(q.link.fileIndex ?? 0) + 1}` });
          perLink.set(q.link.id, [...(perLink.get(q.link.id) ?? []), `${q.problem.severity}:${q.problem.code}`]);
        }
        if (live) {
          const step = Math.max(1, Math.ceil(links.length / PRESENCE_PER_FILE));
          for (let i = 0; i < links.length; i += step) {
            const l = links[i]!;
            const codes = perLink.get(l.id) ?? [];
            recordVerdict.set(l.id, { codes, level: codes.some((c) => c.startsWith("error")) ? "error" : codes.some((c) => c.startsWith("warning")) ? "warning" : "clean", type: l.declaredType, ref: l.ref1 !== undefined || l.ref2 !== undefined });
            presenceQueries.push(JSON.stringify({ k: l.id, s: sourceTitle, si: l.source.line, t: titleFromPath2(parsed.records[i]!.path_2), ti: l.target.line }));
          }
        }
      }

      // export exactly as the tool would (untouched imports, original order) and compare bytes
      const plan = planExport(links, ctx(false), { layouts: () => detectLayout(text) }); // as the store does: the file's own layout
      const out = plan.files[0]?.text ?? "";
      const kind = roundTripKind(bytes, out);
      results.push({ path: rel, live, records: links.length, roundTrip: kind.startsWith("LOSS") ? "LOSS" : kind, ...(kind.startsWith("LOSS") && { detail: kind }), rejectsFile: parsed.generatorRejectsFile });
    }

    // ground truth for the live roots
    let truth: Record<string, unknown> = {};
    if (DB && presenceQueries.length) {
      const q = join(tmpDir(), "presence-in.jsonl");
      writeFileSync(q, presenceQueries.join("\n") + "\n");
      const answers = readFileSync(oracle("presence", "presence.jsonl", q), "utf8").trim().split("\n").map((x) => JSON.parse(x) as Presence);
      truth = confusion(answers, recordVerdict);
    }

    const summary = record("library-links", {
      library: gitHead(LIBRARY!),
      files: results.length,
      liveFiles: results.filter((r) => r.live).length,
      records,
      liveRecords,
      ms: ms(t0),
      roundTrip: { all: tally(results.map((r) => r.roundTrip)), live: tally(results.filter((r) => r.live).map((r) => r.roundTrip)), examples: Object.fromEntries(Object.entries(tally(results.map((r) => r.roundTrip))).map(([k]) => [k, results.filter((r) => r.roundTrip === k).slice(0, 3).map((r) => r.path)])) },
      generatorRejects: results.filter((r) => r.rejectsFile).map((r) => r.path),
      losses: results.filter((r) => r.detail).slice(0, 20).map((r) => `${r.path}: ${r.detail}`),
      issues: summarizeIssues(issues),
      truth,
    });
    console.info(JSON.stringify({ ...summary, issues: Object.fromEntries(Object.entries(summary.issues).map(([k, v]) => [k, v.count])), roundTrip: summary.roundTrip.all, generatorRejects: summary.generatorRejects.length }, null, 1));
    expect(results.filter((r) => r.roundTrip === "LOSS")).toEqual([]);
  });
});

interface Presence {
  k: string;
  books: [boolean, boolean];
  lines?: [boolean, boolean];
  links: { id: number; dir: "same" | "flipped"; type: string; anchors: unknown[] }[];
}

/** Verdict of the tool × what the generator stored. */
function confusion(answers: Presence[], verdicts: Map<string, { codes: string[]; level: string; type: string; ref: boolean }>) {
  const outcome = (p: Presence) => (!p.books[0] ? "source-book-missing" : !p.books[1] ? "target-book-missing" : !p.lines?.[0] || !p.lines?.[1] ? "line-missing" : p.links.length ? "stored" : "not-stored");
  const grid: Record<string, number> = {};
  const byRef: Record<string, number> = {};
  const byCode: Record<string, Record<string, number>> = {};
  const examples: Record<string, string[]> = {};
  for (const p of answers) {
    const v = verdicts.get(p.k)!;
    const o = outcome(p);
    const cell = `${v.level} → ${o}`;
    grid[cell] = (grid[cell] ?? 0) + 1;
    // a record with ref_1/ref_2 has its line_index rewritten by the weekly sync before the build, so a
    // clone older than the database can disagree with what was stored (drift, not a tool error)
    const refCell = `${cell} (${v.ref ? "with ref" : "no ref"})`;
    byRef[refCell] = (byRef[refCell] ?? 0) + 1;
    for (const c of v.codes) (byCode[c] ??= {})[o] = (byCode[c]![o] ?? 0) + 1;
    if ((examples[cell] ??= []).length < 6) examples[cell]!.push(`${p.k.slice(5)} [${v.type}] ${v.codes.join(",")}`);
  }
  return { checked: answers.length, grid, byRef, byCode, examples };
}

function summarizeIssues(issues: { code: string; level: string; live: boolean; example: string }[]) {
  const out: Record<string, { level: string; count: number; live: number; examples: string[] }> = {};
  for (const i of issues) {
    const k = `${i.level}:${i.code}`;
    const e = (out[k] ??= { level: i.level, count: 0, live: 0, examples: [] });
    e.count++;
    if (i.live) e.live++;
    if (e.examples.length < 4 && (i.live || e.examples.length < 2)) e.examples.push(i.example);
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].count - a[1].count));
}

/** How the exported text differs from the original bytes. */
export function roundTripKind(original: Uint8Array, exported: string): string {
  const ours = Buffer.from(exported, "utf8");
  if (Buffer.compare(Buffer.from(original), ours) === 0) return "identical";
  const kinds: string[] = [];
  let o = Buffer.from(original).toString("utf8");
  if (o.startsWith("\uFEFF")) (kinds.push("bom"), (o = o.slice(1)));
  if (o.includes("\r")) (kinds.push("crlf"), (o = o.replace(/\r\n?/g, "\n")));
  if (o === exported) return kinds.join("+");
  if (o.replace(/\n+$/, "") === exported) return [...kinds, o.endsWith("\n\n") ? "final-newlines" : "final-newline"].join("+");
  let data: unknown;
  try {
    data = JSON.parse(o);
  } catch {
    return [...kinds, "not-json"].join("+");
  }
  if (!Array.isArray(data)) return [...kinds, "not-array"].join("+");
  const relaid = JSON.stringify(data, null, 2);
  if (relaid === exported) {
    if (/\\u[0-9a-fA-F]{4}/.test(o)) kinds.push("unicode-escapes");
    if (/:\s*-?\d+\.\d+/.test(o)) kinds.push("number-format");
    if (!/^\[\n {2}\{/.test(o) && o.trim() !== "[]") kinds.push("indentation");
    if (o.endsWith("\n")) kinds.push("final-newline");
    return [...kinds, ...(kinds.length ? [] : ["layout"])].join("+");
  }
  // same values, other key order?
  const sorted = (x: unknown): unknown => (Array.isArray(x) ? x.map(sorted) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sorted(v)])) : x);
  let back: unknown = null;
  try {
    back = JSON.parse(exported);
  } catch {
    /* empty */
  }
  if (JSON.stringify(sorted(data)) === JSON.stringify(sorted(back))) return [...kinds, "key-order"].join("+");
  // records the parser cannot decode are not exported: a loss only if the generator would read them
  if (Array.isArray(back) && back.length < data.length) return [...kinds, "undecodable-records-dropped"].join("+");
  if (Array.isArray(back)) {
    const i = data.findIndex((r, k) => JSON.stringify(sorted(r)) !== JSON.stringify(sorted((back as unknown[])[k])));
    return `LOSS #${i + 1}: ${JSON.stringify(data[i]).slice(0, 160)} → ${JSON.stringify((back as unknown[])[i]).slice(0, 160)}`;
  }
  return "LOSS";
}
