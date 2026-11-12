import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { describeMapping, mappingProblems } from "../../src/core/db-mapping";
import { SourceRegistry } from "../../src/sources/registry";
import { EXTRA_DBS, fileBlob, fingerprint, ms, record } from "./env";

/*
 * Check 6 — databases (and other files) that are NOT an official Otzaria seforim.db, dropped as the
 * user would drop them: SourceRegistry.open → an Otzaria-family source, or the mapping wizard
 * (schema preview + automatic guess), or a refusal with a reason. When the wizard has a complete
 * guess it is opened (openMapped) and its first book read. Every file — and its -wal/-shm — must be
 * byte-for-byte unchanged afterwards (size+mtime, and SHA-256 up to 256 MB).
 *
 *   OTZARIA_EXTRA_DBS="C:/ProgramData/otzaria/books/lexical.db;…" npx vitest run --config vitest.validation.config.ts tests/validation/foreign-dbs.test.ts
 */
const HASH_LIMIT = 256 * 1024 ** 2;

describe.runIf(EXTRA_DBS.length)("check 6: foreign and other databases", () => {
  it("opens, maps or refuses each file without writing it", async () => {
    const out: Record<string, unknown>[] = [];
    for (const path of EXTRA_DBS) {
      if (!existsSync(path)) {
        out.push({ path, outcome: "missing" });
        continue;
      }
      const side = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`].filter((p) => existsSync(p));
      const before = side.map((p) => `${p}=${fingerprint(p)}:${digest(p)}`);
      const registry = new SourceRegistry();
      const res: Record<string, unknown> = { path, size: statSync(path).size, sideFiles: side.slice(1).map((p) => basename(p)) };
      const t0 = performance.now();
      try {
        const r = await registry.open([{ path: basename(path), blob: await fileBlob(path) }]);
        res.openMs = ms(t0);
        if (r.sources.length) {
          const s = r.sources[0]!;
          res.outcome = `opened as ${s.info.kind}`;
          res.warnings = s.info.warnings.map((w) => w.code);
          res.books = s.books.length;
          const first = s.books.find((b) => (b.lineCount ?? 1) > 0);
          if (first) {
            const t1 = performance.now();
            const lines = await registry.lines(first.key, 0, 49);
            res.firstBook = { title: first.title, lines: lines.length, ms: ms(t1), sample: lines[0]?.text.slice(0, 60) };
          }
        } else if (r.needsMapping?.length) {
          const p = r.needsMapping[0]!;
          res.outcome = "mapping wizard";
          res.tables = p.preview.tables.map((t) => `${t.name}(${t.columns.length} cols, ${t.pages} pages)`);
          res.notes = p.preview.notes;
          res.guess = p.guess ? describeMapping(p.guess) : null;
          const problems = p.guess ? mappingProblems(p.preview, p.guess) : [];
          res.guessProblems = problems.map((x) => `${x.level}: ${x.message}`);
          if (p.guess && !problems.some((x) => x.level === "error")) {
            const t1 = performance.now();
            try {
              const opened = await registry.openMapped(p.token, p.guess);
              res.mapped = { books: opened.books.length, ms: ms(t1), warnings: opened.info.warnings.map((w) => w.code) };
              const first = opened.books[0];
              if (first) {
                const t2 = performance.now();
                const lines = await registry.lines(first.key, 0, 49);
                res.mappedFirstBook = { title: first.title, lines: lines.length, ms: ms(t2), sample: lines.slice(0, 2).map((l) => l.text.slice(0, 60)) };
              }
            } catch (err) {
              res.mapped = { error: String(err), ms: ms(t1) };
            }
          }
        } else {
          res.outcome = "refused";
          res.reason = r.skipped.map((s) => s.reason);
        }
      } catch (err) {
        res.outcome = "CRASH";
        res.error = err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 4).join("\n")}` : String(err);
      }
      res.totalMs = ms(t0);
      const after = side.map((p) => `${p}=${fingerprint(p)}:${digest(p)}`);
      res.unchanged = JSON.stringify(after) === JSON.stringify(before);
      out.push(res);
    }
    record("foreign-dbs", out);
    console.info(JSON.stringify(out, null, 1));
    expect(out.filter((r) => r.outcome === "CRASH")).toEqual([]);
    expect(out.filter((r) => r.unchanged === false)).toEqual([]);
  });
});

function digest(path: string): string {
  const size = statSync(path).size;
  return size <= HASH_LIMIT ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16) : "(large)";
}
