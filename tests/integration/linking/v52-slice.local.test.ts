import { describe, expect, it } from "vitest";
import { discoverPairs } from "../../../src/linking/discovery";
import { planMaxLink } from "../../../src/linking/plan";
import { SourceRegistry } from "../../../src/sources/registry";
import { maxlinkJob } from "../../../src/workers/maxlink-job";
import { fileBlob } from "../../validation/env";

/*
 * The personal database (v52) as a corpus of the engines' QA (task 2.17): a slice that runs in seconds and checks what must hold on
 * ANY run, not numbers. Runs only with the file (copyright-restricted, never copied into the repo, opened read-only):
 *   OTZARIA_PERSONAL_DB=C:/Users/User/Documents/DEV/otzarya-unofficial-books-52.db npx vitest run tests/integration/linking/v52-slice.local.test.ts
 * The numbers of a bigger run are in docs/validation/V6_V52_RUN.md (tests/validation/v52-run.test.ts).
 */
const path = process.env.OTZARIA_PERSONAL_DB;

describe.runIf(path)("v52 slice (read-only)", () => {
  async function open() {
    const reg = new SourceRegistry();
    const res = await reg.open([{ path: "v52.db", blob: await fileBlob(path!) }]);
    return { reg, books: res.sources[0]!.books };
  }
  // a translation next to its text, both in v52, a few hundred lines each: structure that is the same line by line
  const DEP = "תרגום על שיר השירים (כתאב אלתאג')";
  const BASE = "שיר השירים (כתאב אלתאג')";

  it("the engines run on a v52 pair: deterministic ids, no suggestion on a heading line, every confidence on the ladder, no failed step", async () => {
    const { reg, books } = await open();
    const dep = books.find((b) => b.title === DEP);
    const base = books.find((b) => b.title === BASE);
    if (!dep || !base) return console.info(`skipped: ${DEP} / ${BASE} not in this database`);
    const library = books.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.lineCount !== undefined && { lineCount: b.lineCount }) }));
    const run = async () => {
      const plan = planMaxLink({ selected: [dep.key], library, singleEngines: [] });
      expect(plan.steps.length).toBeGreaterThan(0);
      return maxlinkJob(reg, plan.steps, {}, {});
    };
    const a = await run();
    const b = await run();
    expect(a.items.every((i) => !i.error)).toBe(true);
    const ids = (r: typeof a) => r.items.flatMap((i) => i.result?.suggestions.map((s) => s.id) ?? []);
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a).length).toBeGreaterThan(0);
    const headings = new Set((await reg.headings(base.key)).map((h) => h.line));
    const depHeadings = new Set((await reg.headings(dep.key)).map((h) => h.line));
    for (const s of a.items.flatMap((i) => i.result?.suggestions ?? [])) {
      expect(["certain", "high", "possible", "ambiguous"]).toContain(s.confidence);
      for (const side of [s.source, s.target]) expect((side.book.key === base.key ? headings : depHeadings).has(side.line)).toBe(false);
    }
  });

  it("the book list is a corpus: titles name bases, and discovery proposes without linking anything", async () => {
    const { books } = await open();
    const r = discoverPairs(books.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.lineCount !== undefined && { lineCount: b.lineCount }) })));
    expect(r.summary.titled).toBeGreaterThan(100);
    expect(r.proposals.every((p) => p.requiresReview)).toBe(true);
    expect(r.proposals.length + r.unresolved.length).toBe(r.summary.titled);
  });
});
