import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileBlob } from "../../../src/cli/node-files";
import { runRepository } from "../../../src/cli/run";

/*
 * The runner's database Blob (V7 round 2, item 8). fs.openAsBlob reports a file over 4 GiB modulo 2^32 on Windows (Node 24), so the
 * first run against the real seforim.db (4,769,005,568 bytes) found it "damaged" and linked nothing to the official library. The
 * descriptor-backed Blob must behave as a Blob on every slice; the real database is opened in the local test below.
 */
const dir = mkdtempSync(join(tmpdir(), "linker-blob-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fileBlob: a file as a lazily read Blob", () => {
  it("size, slices (nested, negative, past the end) and the readers give the file's bytes", async () => {
    const p = join(dir, "x.bin");
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) % 251);
    writeFileSync(p, bytes);
    const { blob, close } = fileBlob(p);
    const real = new Blob([bytes]);
    expect(blob.size).toBe(70_000);
    const cases: [number, number | undefined][] = [[0, undefined], [100, 4196], [69_000, 80_000], [-500, undefined], [-500, -100], [5, 2], [80_000, 90_000]];
    for (const [s, e] of cases) {
      const a = new Uint8Array(await blob.slice(s, e).arrayBuffer());
      const b = new Uint8Array(await real.slice(s, e).arrayBuffer());
      expect([...a], `${s}..${e}`).toEqual([...b]);
      expect(blob.slice(s, e).size).toBe(real.slice(s, e).size);
    }
    expect([...new Uint8Array(await blob.slice(1000, 9000).slice(-100, 50_000).arrayBuffer())]).toEqual([...new Uint8Array(await real.slice(1000, 9000).slice(-100, 50_000).arrayBuffer())]);
    expect(await blob.slice(0, 10).text()).toBe(await real.slice(0, 10).text());
    close();
  });
});

const DB = process.env.OTZARIA_DB;
describe.runIf(DB)("the runner opens the real seforim.db (local: OTZARIA_DB)", () => {
  it("over 4 GiB: opened, not reported damaged, and the database is the same afterwards", { timeout: 300_000 }, async () => {
    const before = statSync(DB!);
    const { report } = await runRepository({ repo: "tests/fixtures/repos/zmanenu", db: DB!, dryRun: true, minConfidence: "high" });
    expect(report.notices.filter((n) => /לא נפתח|פגום/.test(`${n.text} ${(n.details ?? []).join(" ")}`))).toEqual([]);
    // the commentary on בראשית is linked to the official book of the real database
    expect(report.links.external).toBeGreaterThan(0);
    const after = statSync(DB!);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });
});
