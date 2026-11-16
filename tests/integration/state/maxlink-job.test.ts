import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { EngineId } from "../../../src/linking/automatic";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * The batch job (V5 P1-8) through the store: a folder of commentaries and their base, run book after
 * book — paused and resumed, a failing book that does not stop the others and is re-run alone, a reload
 * in the middle (a new store over the same browser storage), and a re-run after one book changed that
 * skips the unchanged ones and keeps every decision.
 */
const HEB = ["א", "ב", "ג", "ד", "ה"];
const nl = "\n";
const text = (path: string, lines: readonly string[]) => ({ path, blob: new Blob([strToU8(lines.join(nl))]) });
const BASE = ["<h1>בראשית</h1>", ...HEB.flatMap((p, c) => [`<h2>פרק ${p}</h2>`, ...HEB.map((_, v) => `(${HEB[v]}) פסוק ${v + 1} של פרק ${c + 1} בספר.`)])];
const commentary = (n: number, extra = "") => [`<h1>ביאור ${n} על בראשית</h1>`, `<h2>פרק ${HEB[n - 1]}</h2>`, ...HEB.flatMap((p, v) => [`<h3>פסוק ${p}</h3>`, `ביאור ${n} לפסוק ${v + 1}${extra}`])];
const folder = (changed?: number, prefix = "ביאורים") => [
  text(`${prefix}/בראשית.txt`, BASE),
  ...[1, 2, 3, 4, 5].map((n) => text(`${prefix}/ביאור ${n} על בראשית.txt`, commentary(n, n === changed ? " (תוקן)" : ""))),
];
const HEADINGS: ReadonlySet<EngineId> = new Set(["headings"]);
const memKv = () => {
  const mem = new Map<string, string>();
  const kv: KeyValueStore = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k) };
  return { mem, kv };
};

/** A store whose worker calls are counted per book, and can fail or be interrupted on the n-th call. */
function makeStore(hooks: { failTitle?: string; onCall?: (title: string, n: number) => void } = {}) {
  const service = registryService(new SourceRegistry());
  const calls: string[] = [];
  const run = service.runMaxLink!.bind(service);
  const wrapped: BooksService = {
    ...service,
    runMaxLink: async (steps, options, opts) => {
      const title = steps[0]!.source.title;
      calls.push(title);
      hooks.onCall?.(title, calls.length);
      if (title === hooks.failTitle) throw new Error("הקובץ השתנה אחרי שנבחר, ולכן אי אפשר לקרוא אותו.");
      return run(steps, options, opts);
    },
  };
  const store = new AppStore(wrapped, { save: () => {} }, loadPreferences(null));
  return { store, calls };
}

async function openFolder(store: AppStore, changed?: number) {
  await store.openFiles(folder(changed));
  const src = store.sources.value.at(-1)!;
  return { kind: "source", id: src.info.id } as const;
}

describe("max-link as a batch job", () => {
  it("runs book after book; per-book and per-engine progress; the base itself is 'not planned' with the reason", async () => {
    const { store, calls } = makeStore();
    const scope = await openFolder(store);
    expect(await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים")).toBe(true);
    const job = store.maxLink.job.value!;
    expect(job.state).toBe("done");
    expect(calls).toHaveLength(5);
    expect(job.books.find((b) => b.title === "בראשית")!.status).toBe("not-planned");
    for (const n of [1, 2, 3, 4, 5]) expect(job.books.find((b) => b.title === `ביאור ${n} על בראשית`)).toMatchObject({ status: "done", suggestions: 5, engines: { headings: [1, 1, 0] } });
    expect(store.suggestions.run.value!.result.suggestions).toHaveLength(25);
  });

  it("pause keeps the finished books (shown as the run), resume runs only the rest", async () => {
    const { store, calls } = makeStore({ onCall: (_t, n) => n === 3 && store.maxLink.pause() });
    const scope = await openFolder(store);
    expect(await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים")).toBe(true);
    let job = store.maxLink.job.value!;
    expect(job.state).toBe("paused");
    // the third book was stopped while it ran: it waits; the first two are shown
    expect(job.books.filter((b) => b.status === "done")).toHaveLength(2);
    expect(store.suggestions.run.value!.result.suggestions).toHaveLength(10);
    expect(store.notices.value.at(-1)!.text).toContain("הושהה");
    expect(await store.maxLink.resume()).toBe(true);
    job = store.maxLink.job.value!;
    expect(job.state).toBe("done");
    expect(calls.slice(3)).toEqual(["ביאור 3 על בראשית", "ביאור 4 על בראשית", "ביאור 5 על בראשית"]);
    expect(store.suggestions.run.value!.result.suggestions).toHaveLength(25);
  });

  it("cancel keeps the finished books too; the app bar's cancel is the same", async () => {
    const { store } = makeStore({ onCall: (_t, n) => n === 2 && store.task.value!.cancel() });
    const scope = await openFolder(store);
    expect(await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים")).toBe(true);
    expect(store.maxLink.job.value!.state).toBe("cancelled");
    expect(store.suggestions.run.value!.result.suggestions).toHaveLength(5);
    // not "nothing changed": the finished book is there
    expect(store.notices.value.some((n) => n.text.includes("שום דבר לא השתנה"))).toBe(false);
  });

  it("a failing book does not stop the others; 'retry failed' runs only it", async () => {
    const hooks: { failTitle?: string } = { failTitle: "ביאור 2 על בראשית" };
    const { store, calls } = makeStore(hooks);
    const scope = await openFolder(store);
    await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים");
    let job = store.maxLink.job.value!;
    expect(job.state).toBe("done");
    const failed = job.books.find((b) => b.title === "ביאור 2 על בראשית")!;
    expect(failed).toMatchObject({ status: "failed", engines: { headings: [1, 0, 1] } });
    expect(failed.why).toContain("הקובץ השתנה");
    expect(job.books.filter((b) => b.status === "done")).toHaveLength(4);
    expect(store.notices.value.at(-1)!.kind).toBe("warning");
    delete hooks.failTitle;
    calls.length = 0;
    await store.maxLink.retryFailed();
    job = store.maxLink.job.value!;
    expect(calls).toEqual(["ביאור 2 על בראשית"]);
    expect(job.books.filter((b) => b.status === "done")).toHaveLength(5);
    expect(store.suggestions.run.value!.result.suggestions).toHaveLength(25);
  });

  it("survives a reload: the job is offered again, its finished books come back from storage and are not run again", async () => {
    const { kv } = memKv();
    const a = makeStore({ onCall: (_t, n) => n === 4 && a.store.maxLink.pause() });
    a.store.maxLink.startPersist(kv);
    const scope = await openFolder(a.store);
    await a.store.maxLink.run(a.store.maxLink.plan(scope, HEADINGS), "ביאורים");
    expect(a.store.maxLink.job.value!.state).toBe("paused");

    // "the tab was closed": a new store over the same storage, the folder chosen again
    const b = makeStore();
    b.store.maxLink.startPersist(kv);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.store.maxLink.jobRestored.value).toBe(true);
    expect(b.store.maxLink.job.value!.books.filter((x) => x.status === "done")).toHaveLength(3);
    expect(b.store.maxLink.missingTitles()).toHaveLength(6); // the base too
    await openFolder(b.store);
    expect(b.store.maxLink.missingTitles()).toEqual([]);
    expect(await b.store.maxLink.resume()).toBe(true);
    expect(b.calls).toEqual(["ביאור 4 על בראשית", "ביאור 5 על בראשית"]);
    expect(b.store.maxLink.job.value!.state).toBe("done");
    expect(b.store.suggestions.run.value!.result.suggestions).toHaveLength(25);
    // the restored suggestions are bound to this session's books
    const keys = new Set([...b.store.books.value.keys()]);
    expect(b.store.suggestions.run.value!.result.suggestions.every((s) => keys.has(s.source.book.key) && keys.has(s.target.book.key))).toBe(true);
  });

  it("re-run after a book changed: only it runs; approved, edited and rejected suggestions keep their state", async () => {
    const { store, calls } = makeStore();
    const scope = await openFolder(store);
    await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים");
    const sugs = store.suggestions.run.value!.result.suggestions;
    const on = (n: number) => sugs.filter((s) => s.source.book.title === `ביאור ${n} על בראשית`).map((s) => s.id);
    // decisions: approve two of book 1 and edit one of them, reject one of book 4, approve one of book 3
    store.suggestions.approve(on(1).slice(0, 2));
    store.setType([`auto:${on(1)[0]}`], "reference");
    store.suggestions.reject([on(4)[0]!]);
    store.suggestions.approve([on(3)[0]!]);
    const links = store.allLinks.value.length;

    // book 3 is edited and the folder is opened again (new session keys for every book)
    await store.closeSource(store.sources.value[0]!.info.id);
    await openFolder(store, 3);
    calls.length = 0;
    expect(await store.maxLink.rerunChanged()).toBe(true);
    expect(calls).toEqual(["ביאור 3 על בראשית"]);
    const job = store.maxLink.job.value!;
    expect(job.books.filter((b) => b.status === "unchanged").map((b) => b.title)).toEqual(["ביאור 1 על בראשית", "ביאור 2 על בראשית", "ביאור 4 על בראשית", "ביאור 5 על בראשית"]);
    expect(job.books.find((b) => b.title === "ביאור 3 על בראשית")).toMatchObject({ status: "done", changedDecisions: 1 });
    // nothing decided was undone or offered again as new
    expect(store.allLinks.value).toHaveLength(links);
    expect(store.allLinks.value.find((l) => l.id === `auto:${on(1)[0]}`)!.declaredType).toBe("reference");
    const st = store.suggestions.state.value;
    expect(st.get(on(1)[0]!)).toBe("approved");
    expect(st.get(on(1)[1]!)).toBe("approved");
    expect(st.get(on(4)[0]!)).toBe("rejected");
    expect(store.suggestions.counts.value).toMatchObject({ approved: 3, rejected: 1 });
  });
});
