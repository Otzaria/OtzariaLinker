import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { EngineId } from "../../../src/linking/automatic";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * MaxLink does not compute again what has not changed (V7 §2.15): a book's result is reused while its
 * fingerprint — its text, its bases' texts, its steps, the run's settings — is the same, also when the user
 * starts the run again; and anything that changes the engines' output (an engine option, the books the
 * library treats as Sefaria's) is part of the fingerprint, so it runs again.
 */
const HEB = ["א", "ב", "ג", "ד", "ה"];
const text = (path: string, lines: readonly string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const BASE = ["<h1>בראשית</h1>", ...HEB.flatMap((p, c) => [`<h2>פרק ${p}</h2>`, ...HEB.map((_, v) => `(${HEB[v]}) פסוק ${v + 1} של פרק ${c + 1} בספר.`)])];
const commentary = (n: number) => [`<h1>ביאור ${n} על בראשית</h1>`, `<h2>פרק ${HEB[n - 1]}</h2>`, ...HEB.flatMap((p, v) => [`<h3>פסוק ${p}</h3>`, `ביאור ${n} לפסוק ${v + 1}`])];
const folder = () => [text("ביאורים/בראשית.txt", BASE), ...[1, 2, 3].map((n) => text(`ביאורים/ביאור ${n} על בראשית.txt`, commentary(n)))];
const HEADINGS: ReadonlySet<EngineId> = new Set(["headings"]);

function makeStore() {
  const service = registryService(new SourceRegistry());
  const calls: string[] = [];
  const run = service.runMaxLink!.bind(service);
  const wrapped: BooksService = {
    ...service,
    runMaxLink: async (steps, options, opts) => {
      calls.push(steps[0]!.source.title);
      return run(steps, options, opts);
    },
  };
  return { store: new AppStore(wrapped, { save: () => {} }, loadPreferences(null)), calls };
}

async function opened() {
  const { store, calls } = makeStore();
  await store.openFiles(folder());
  const scope = { kind: "source", id: store.sources.value.at(-1)!.info.id } as const;
  await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים");
  expect(calls).toHaveLength(3);
  calls.length = 0;
  return { store, calls, scope };
}

describe("max-link: unchanged work is not computed again (§2.15)", () => {
  it("running the same plan again with the same settings reuses every book's result", async () => {
    const { store, calls, scope } = await opened();
    const before = store.suggestions.run.value!.result.suggestions.map((s) => s.id).sort();
    expect(await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים")).toBe(true);
    expect(calls).toEqual([]);
    const job = store.maxLink.job.value!;
    expect(job.state).toBe("done");
    expect(job.books.filter((b) => b.status === "unchanged").map((b) => b.title).sort()).toEqual(["ביאור 1 על בראשית", "ביאור 2 על בראשית", "ביאור 3 על בראשית"]);
    expect(store.suggestions.run.value!.result.suggestions.map((s) => s.id).sort()).toEqual(before);
  });

  it("a changed engine option is a changed setting: every book runs again", async () => {
    const { store, calls, scope } = await opened();
    await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים", { engineOptions: { headings: { ranges: false } } });
    expect(calls.sort()).toEqual(["ביאור 1 על בראשית", "ביאור 2 על בראשית", "ביאור 3 על בראשית"]);
    expect(store.maxLink.job.value!.books.some((b) => b.status === "unchanged")).toBe(false);
  });

  it("the books the library treats as Sefaria's change the engines' output: a re-run runs them again", async () => {
    const { store, calls } = await opened();
    // nothing changed: nothing runs
    expect(await store.maxLink.rerunChanged()).toBe(true);
    expect(calls).toEqual([]);
    // the user says the folder is the library's edition: "בראשית" is now a Sefaria book (no range on its side)
    for (const s of store.sources.value) store.setLibrarySource(s.info.id, true);
    expect(store.isSefariaOwned({ title: "בראשית" })).toBe(true);
    expect(await store.maxLink.rerunChanged()).toBe(true);
    expect(calls.sort()).toEqual(["ביאור 1 על בראשית", "ביאור 2 על בראשית", "ביאור 3 על בראשית"]);
  });
});
