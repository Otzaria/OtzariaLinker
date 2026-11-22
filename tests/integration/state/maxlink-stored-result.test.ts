import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { EngineId } from "../../../src/linking/automatic";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * QA round 2, F: a stored result of a book (IndexedDB, editable by anyone) is checked before it is trusted:
 * damaged JSON or a wrong shape counts as "nothing kept", so the book simply runs again — same as when storage
 * was cleared (state/maxlink.ts), instead of the restore throwing.
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


describe("a damaged stored book result", () => {
  it("is treated as missing: the book runs again and nothing throws", async () => {
    const { mem, kv } = memKv();
    const a = makeStore({ onCall: (_t, n) => n === 4 && a.store.maxLink.pause() });
    a.store.maxLink.startPersist(kv);
    const scope = await openFolder(a.store);
    await a.store.maxLink.run(a.store.maxLink.plan(scope, HEADINGS), "ביאורים");
    expect(a.store.maxLink.job.value!.books.filter((x) => x.status === "done")).toHaveLength(3);

    const resultKeys = [...mem.keys()].filter((k) => /:[0-9]+$/.test(k) && !k.endsWith(":job"));
    expect(resultKeys.length).toBeGreaterThanOrEqual(2);
    mem.set(resultKeys[0]!, "{not json");
    mem.set(resultKeys[1]!, JSON.stringify({ title: 5, source: "x", steps: "y", dbLinkKeys: [1] }));

    const b = makeStore();
    b.store.maxLink.startPersist(kv);
    await new Promise((r) => setTimeout(r, 0));
    await openFolder(b.store);
    await expect(b.store.maxLink.resume()).resolves.toBe(true);
    // the two books with a damaged result run again, with the two that were still waiting
    expect(b.calls).toHaveLength(4);
    expect(b.store.maxLink.job.value!.state).toBe("done");
    expect(b.store.suggestions.run.value!.result.suggestions).toHaveLength(25);
  });
});
