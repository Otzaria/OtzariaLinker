import { describe, expect, it, vi } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { headingLevel } from "../../../../src/core/text/html";
import type { EngineBook } from "../../../../src/linking/automatic/types";

/*
 * The performance path of the ד"ה engine, asserted as WORK, not wall-clock: how many base lines a
 * commentary line is measured against (bestRun calls). Before the start index (engine.ts `startsIn`)
 * and the per-line run cache, every phase and every ladder rung measured every line of the window —
 * O(commentary × window × rungs); "שער הציון ← משנה ברורה" took minutes. Now a base line is measured
 * only if one of the ד"ה's first words may start a step there, and at most once per spec.
 */
const calls = vi.hoisted(() => ({ bestRun: 0 }));
vi.mock("../../../../src/linking/automatic/dibur-hamatchil/search", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../../src/linking/automatic/dibur-hamatchil/search")>();
  return { ...mod, bestRun: (...args: Parameters<typeof mod.bestRun>) => (calls.bestRun++, mod.bestRun(...args)) };
});
const { runDiburHamatchilEngine } = await import("../../../../src/linking/automatic/dibur-hamatchil");

const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria", isBaseBook: false });
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });

// filler lines whose words never meet the quotes (distinct letters, so no fuzzy or bridged step either)
const FILLER = ["גדגד זטזט חטחט", "כלכל מנמנ סעסע", "פצפצ קרקר שתשת"];
function base(n: number): EngineBook {
  const lines = ["<h1>בסיס</h1>"];
  for (let i = 0; i < n; i++) lines.push(`${FILLER[i % 3]} ${FILLER[(i + 1) % 3]}`);
  lines.push("בראשית ברא אלהים את השמים ואת הארץ");
  return book(ref("b", "בסיס"), lines);
}
const COMMENTARY = book(ref("c", "פירוש"), [
  "<b>בראשית ברא.</b> פירוש", //            found verbatim
  "<b>ויאמר משה אל העם.</b> לא נמצא", //     an explicit ד"ה that is nowhere: strict, A, B, C, D, unique anchor
  "מילים בלי גבול שאינן בספר", //            no boundary, not found
]);

function work(n: number): { calls: number; found: number } {
  calls.bestRun = 0;
  const r = runDiburHamatchilEngine(COMMENTARY, base(n));
  return { calls: calls.bestRun, found: r.suggestions.length };
}

describe("ד\"ה engine — work does not grow with the window", () => {
  it("lines that hold none of the ד\"ה's opening words are never measured", () => {
    const small = work(300);
    const large = work(3000);
    expect(small.found).toBe(1);
    expect(large.found).toBe(1);
    // the whole base is the window (no headings); before, the not-found line alone cost 3,000+ runs per rung
    expect(large.calls).toBe(small.calls);
    expect(large.calls).toBeLessThan(20);
  });
});
