/*
 * An engine's work as a generator that yields at its checkpoints — the places where it reads
 * `ctx.signal` and reports progress. In-process callers (tests, tools, the benchmark) run it to the
 * end at once (runToEnd), exactly as the synchronous engine ran. The worker runs it in slices and
 * gives the thread back between them (runSliced): only then does the worker read its messages, so a
 * cancel reaches `ctx.signal` while the engine runs, and the reader's requests are answered meanwhile
 * (review C3, M6: before, a cancel was read only after the engine ended, and the watchdog replaced
 * the worker — losing every open source — whenever an engine ran longer than a few seconds).
 */

export type EngineSteps<T> = Generator<void, T, void>;

/** Runs the steps to the end, without giving the thread back. */
export function runToEnd<T>(steps: EngineSteps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** How long a slice runs before the thread is given back (the worker's latency for a cancel or a page of lines). */
export const SLICE_MS = 20;

/**
 * Runs the steps, giving the thread back (a macrotask) once a slice of SLICE_MS has passed. The
 * overhead is one yield per slice: well under 1% of the run.
 */
export async function runSliced<T>(steps: EngineSteps<T>, sliceMs = SLICE_MS, yieldThread: () => Promise<void> = macrotask): Promise<T> {
  let until = performance.now() + sliceMs;
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() >= until) {
      await yieldThread();
      until = performance.now() + sliceMs;
    }
  }
}

/**
 * A new task, after the messages already waiting: a MessageChannel message, which neither a browser
 * nor Node clamps (setTimeout(0) is clamped to 4 ms once nested, ~15% of a 20 ms slice).
 */
export function macrotask(): Promise<void> {
  if (typeof MessageChannel !== "function") return new Promise((r) => setTimeout(r, 0));
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => (port1.close(), resolve());
    port2.postMessage(null);
  });
}
