import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { engineSteps, runEngine, runEngineSliced, runSliced, type EngineBook, type EngineId } from "../../../src/linking/automatic";

/*
 * Review C3 / M6: in the worker an engine must give the thread back while it runs, or a cancel is read
 * only after it ends (and the watchdog replaced the worker). The engines are steps (steps.ts): the same
 * code runs to the end in-process (runEngine) and in slices in the worker (runEngineSliced).
 *
 * The books are generated: a base of N lines of distinct words and a commentary quoting each line's
 * first words in bold, under the same chapter headings — enough lines for many slices.
 */
const LETTERS = "אבגדהוזחטיכלמנסעפצקרשת";
const word = (n: number) => {
  let s = "";
  for (let k = 0; k < 3; k++, n = Math.floor(n / LETTERS.length)) s += LETTERS[n % LETTERS.length];
  return s;
};
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria" });
function pair(n: number): { commentary: EngineBook; base: EngineBook } {
  const base: string[] = [];
  const comm: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 50 === 0) {
      const h = `<h2>פרק ${word(9000 + i / 50)}</h2>`;
      base.push(h);
      comm.push(h);
    }
    const w = [0, 1, 2, 3, 4, 5].map((k) => word(6 * i + k));
    base.push(w.join(" "));
    comm.push(`<b>${w[0]} ${w[1]} ${w[2]}.</b> פירוש`);
  }
  const lines = (texts: string[]) => texts.map((text, index) => ({ index, text, heading: text.startsWith("<h2>") ? 2 : null }));
  return { commentary: { book: ref("c", "פירוש על בסיס"), lines: lines(comm) }, base: { book: ref("b", "בסיס"), lines: lines(base) } };
}

describe("engines as steps (review C3)", () => {
  const { commentary, base } = pair(1500);

  it.each<EngineId>(["dibur-hamatchil", "headings"])("%s: sliced gives exactly the synchronous result, and yields at every line", async (engine) => {
    const sync = runEngine(engine, commentary, base);
    let yields = 0;
    const sliced = await runSliced(engineSteps(engine, commentary, base), 0, async () => void yields++);
    expect(sliced).toEqual(sync);
    expect(yields).toBeGreaterThanOrEqual(commentary.lines.length);
    if (engine === "dibur-hamatchil") expect(sync.suggestions.length).toBeGreaterThan(1000);
  });

  it("a cancel that arrives as a message while the engine runs stops it at its next line", async () => {
    const full = runEngine("dibur-hamatchil", commentary, base);
    const ac = new AbortController();
    let progressed = 0;
    // the cancel is a task (a message to the worker): it can run only when the engine gives the thread back
    const run = runSliced(engineSteps("dibur-hamatchil", commentary, base, {}, { signal: ac.signal, progress: (d) => (progressed = d) }), 0);
    setTimeout(() => ac.abort(), 0);
    const r = await run;
    expect(r.notes.map((n) => n.code)).toContain("engine/aborted");
    expect(progressed).toBeLessThan(commentary.lines.length);
    expect(r.suggestions.length).toBeLessThan(full.suggestions.length);
  });

  it("runEngineSliced (the worker's call) gives the synchronous result", async () => {
    expect(await runEngineSliced("headings", commentary, base)).toEqual(runEngine("headings", commentary, base));
  });
});
