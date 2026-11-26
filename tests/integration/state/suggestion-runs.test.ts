import { readFileSync } from "node:fs";
import { effect } from "@preact/signals";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore, type Task } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * A long run as the user lives it (V7 §3.16, findings #41 B11): what the progress says while the job prepares, what a cancel
 * leaves on the screen, and a batch whose failed books are run again without losing the others.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const text = (path: string, lines: readonly string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const key = (store: AppStore, title: string) => [...store.books.value.values()].find((b) => b.title === title)!.key;
const makeStore = (service: BooksService = registryService(new SourceRegistry())) => new AppStore(service, { save: () => {} }, loadPreferences(null));

/** Every state of the running task, and a hook that acts on it once. */
function watchTask(store: AppStore, act?: (t: Task) => boolean) {
  const seen: Task[] = [];
  let done = false;
  const stop = effect(() => {
    const t = store.task.value;
    if (!t) return;
    seen.push(t);
    if (!done && act?.(t)) (done = true), t.cancel();
  });
  return { seen, stop };
}

// a whole citations run over 3,000 lines: about a second alone, several under a loaded machine
describe("a citations search (#41 B11)", { timeout: 30_000 }, () => {
  const BOOK = ["<h1>חיבור ארוך</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 3000 }, (_, i) => `שורה ${i + 1}, כמו שנאמר (בראשית א, ${["א", "ב", "ג"][i % 3]}) ועוד.`)];

  it("says that it prepares before its first count, then which stage it is in", async () => {
    const store = makeStore();
    await store.openFiles([DB, text("חיבור ארוך.txt", BOOK)]);
    const { seen, stop } = watchTask(store);
    expect(await store.suggestions.runCitations(key(store, "חיבור ארוך"))).toBe(true);
    stop();
    const counts = seen.map((t) => t.count).filter(Boolean);
    expect(counts[0]).toContain("מכין");
    expect(counts.some((c) => c!.includes("קורא את הספר"))).toBe(true);
    expect(counts.some((c) => c!.includes("ספרים המצוטטים"))).toBe(true);
  });

  it("cancelled while it prepares: the run stays, says it stopped before reading the book, and nothing is called a result", async () => {
    const store = makeStore();
    await store.openFiles([DB, text("חיבור ארוך.txt", BOOK)]);
    const { stop } = watchTask(store, () => true);
    expect(await store.suggestions.runCitations(key(store, "חיבור ארוך"))).toBe(true);
    stop();
    const run = store.suggestions.run.value!;
    expect(run.partial).toBe(true);
    expect(run.result.suggestions).toEqual([]);
    expect(run.result.notes.find((n) => n.code === "engine/aborted")!.text).toContain("בשלב ההכנה");
    const notice = store.notices.value.at(-1)!;
    expect(notice.kind).toBe("warning");
    expect(notice.text).toContain("לפני שנמצאו הצעות");
    expect(notice.text).not.toContain("מוצגות 0");
  });

  it("cancelled while reading the book: the citations recognised so far are still checked, and shown as partial", async () => {
    const store = makeStore();
    await store.openFiles([DB, text("חיבור ארוך.txt", BOOK)]);
    const { stop } = watchTask(store, (t) => !!t.count?.includes("קורא את הספר"));
    expect(await store.suggestions.runCitations(key(store, "חיבור ארוך"))).toBe(true);
    stop();
    const run = store.suggestions.run.value!;
    expect(run.partial).toBe(true);
    expect(run.result.suggestions.length).toBeGreaterThan(0);
    expect(run.result.suggestions.length).toBeLessThan(3000);
    expect(store.notices.value.at(-1)!.text).toContain("חלקיות");
  });
});

describe("a batch run (V7 §3.16)", () => {
  const HEB = ["א", "ב", "ג", "ד", "ה"];
  const BASE = ["<h1>בראשית</h1>", ...HEB.flatMap((p, c) => [`<h2>פרק ${p}</h2>`, ...HEB.map((_, v) => `(${HEB[v]}) פסוק ${v + 1} של פרק ${c + 1} בספר.`)])];
  const commentary = (n: number) => [`<h1>ביאור ${n} על בראשית</h1>`, `<h2>פרק ${HEB[n - 1]}</h2>`, ...HEB.flatMap((p, v) => [`<h3>פסוק ${p}</h3>`, `ביאור ${n} לפסוק ${v + 1}`])];
  const folder = [text("ביאורים/בראשית.txt", BASE), ...[1, 2, 3].map((n) => text(`ביאורים/ביאור ${n} על בראשית.txt`, commentary(n)))];

  it("counts books, and runs again only the books that failed, keeping what the others found and every decision", async () => {
    const real = registryService(new SourceRegistry());
    const calls: string[][] = [];
    const service: BooksService = {
      ...real,
      runBatch: async (engine, pairs, options, opts) => {
        calls.push(pairs.map((p) => p.source.title));
        const items = await real.runBatch(engine, pairs, options, opts);
        // the first run: the second book fails, as a book that changed on disk would
        return calls.length === 1 ? items.map((it) => (it.source.title === "ביאור 2 על בראשית" ? { source: it.source, target: it.target, error: "הקובץ השתנה אחרי שנבחר." } : it)) : items;
      },
    };
    const store = makeStore(service);
    await store.openFiles(folder);
    const { seen, stop } = watchTask(store);
    expect(await store.suggestions.runBatch("headings", store.sources.value.at(-1)!.info.id)).toBe(true);
    expect(seen.some((t) => t.count === "ספר 1 מתוך 3")).toBe(true);
    const first = store.suggestions.run.value!;
    expect(first.batch!.find((r) => r.source.title === "ביאור 2 על בראשית")!.problem).toContain("השתנה");
    const kept = first.result.suggestions.length;
    expect(kept).toBe(10);
    store.suggestions.approve([first.result.suggestions[0]!.id]);

    expect(store.suggestions.failedBatchBooks()).toEqual(["ביאור 2 על בראשית"]);
    expect(await store.suggestions.rerunFailed()).toBe(true);
    stop();
    expect(calls.at(-1)).toEqual(["ביאור 2 על בראשית"]);
    const run = store.suggestions.run.value!;
    expect(run.result.suggestions).toHaveLength(15);
    // (the base itself, in the same folder, stays listed as a book with no base of its own)
    expect(run.batch!.filter((r) => r.problem).map((r) => r.source.title)).toEqual(["בראשית"]);
    expect(run.batch!.find((r) => r.source.title === "ביאור 2 על בראשית")!.suggestions).toBe(5);
    expect(store.suggestions.counts.value.approved).toBe(1);
    expect(store.suggestions.failedBatchBooks()).toEqual([]);
  });
});
