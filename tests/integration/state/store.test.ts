import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

function makeStore() {
  const reg = new SourceRegistry();
  const service = registryService(reg);
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(service, { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב", "יג", "יד", "טו", "טז", "יז", "יח", "יט", "כ", "כא", "כב", "כג", "כד", "כה", "כו", "כז", "כח", "כט", "ל"][n]!;
/** a commentary the database has no links for: chapter 1 of בראשית, verse by verse */
const BIUR = {
  path: "ביאור על בראשית.txt",
  blob: new Blob([strToU8(["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 30 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()].join(String.fromCharCode(10)))]),
};
const COMMENTARY = { path: "פירוש על בראשית.txt", blob: new Blob([strToU8("<h1>פירוש על בראשית</h1>\nבראשית - פירוש ראשון\nויאמר - פירוש שני")]) };

describe("AppStore — the manual linking flow end to end (without UI)", () => {
  it("open → pick → create → undo/redo → export", async () => {
    const { store, saved } = makeStore();
    await store.openFiles([DB, COMMENTARY]);
    expect(store.screen.value).toBe("workspace");
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    const comm = [...store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!;

    await store.lines.load(bereshit.key, 0, 10);
    await store.lines.load(comm.key, 0, 2);
    const verse = [0, 1, 2, 3, 4, 5].find((i) => store.lines.peek(bereshit.key, i)!.heading === null)!;

    store.pickLine("source", comm.key, 1);
    store.pickLine("target", bereshit.key, verse);
    // Bereshit is a Sefaria book: the library needs ref_2, and the builder builds it from the line heRef (B1)
    expect(store.draft.value!.ref2).toBe("Genesis 1:1");
    expect(store.draftProblems.value.map((p) => p.code)).not.toContain("sefaria/ref2-required");
    // "פירוש על בראשית" names its base: the type follows the titles → "source" (stored base → commentary)
    expect(store.draft.value).toMatchObject({ declaredType: "source", source: { line: 1 }, target: { line: verse } });
    expect(store.draft.value!.heRef2).toBe(store.lines.peek(bereshit.key, verse)!.heRef);

    const link = store.createFromDraft()!;
    expect(link).toMatchObject({ status: "new", provenance: "user" });
    expect(store.pick.source.value).toEqual({ bookKey: comm.key, line: 2 }); // advances to the next line
    expect(store.dirty.value).toBe(true);

    store.undo();
    expect(store.allLinks.value).toEqual([]);
    store.redo();
    expect(store.allLinks.value).toHaveLength(1);

    const plan = (await store.exchange.prepareExport())!;
    expect(plan.counts).toMatchObject({ new: 1, heldBack: 0, files: 1 });
    store.exchange.saveExport(plan);
    expect(saved[0]!.name).toBe("פירוש על בראשית_links.json");
    expect(JSON.parse(saved[0]!.data as string)[0]).toMatchObject({ line_index_1: 2, path_2: "בראשית.txt", line_index_2: verse + 1, ref_2: "Genesis 1:1", "Conection Type": "source" });
    expect(store.dirty.value).toBe(false);
  });

  it("a link to a heading line is refused, with the reason", async () => {
    const { store } = makeStore();
    await store.openFiles([DB, COMMENTARY]);
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    const comm = [...store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!;
    await store.lines.load(bereshit.key, 0, 5);
    await store.lines.load(comm.key, 0, 2);
    store.pickLine("source", comm.key, 1);
    store.pickLine("target", bereshit.key, 0); // <h1>בראשית</h1>
    expect(store.draftProblems.value.map((p) => p.code)).toContain("export/heading-line");
    expect(store.createFromDraft()).toBeNull();
  });

  it("an imported links file binds to books opened later by exact title, and re-exports unchanged", async () => {
    const { store, saved } = makeStore();
    const text = JSON.stringify([{ line_index_1: 2, heRef_2: "בראשית א, א", path_2: "בראשית.txt", line_index_2: 3, "Conection Type": "commentary" }], null, 2);
    await store.openFiles([{ path: "פירוש על בראשית_links.json", blob: new Blob([strToU8(text)]) }]);
    expect(store.allLinks.value[0]!.source.book.origin).toBe("unknown");
    await store.openFiles([DB, COMMENTARY]);
    const comm = [...store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!;
    expect(store.linksOfBook(comm.key)).toHaveLength(1);
    const plan = (await store.exchange.prepareExport())!;
    expect(plan.heldBack).toEqual([]);
    store.exchange.saveExport(plan);
    expect(saved[0]!.data).toBe(text);
  });

  it("delete of an imported link marks it; export drops it; undo brings it back", async () => {
    const { store } = makeStore();
    const text = JSON.stringify([{ line_index_1: 2, heRef_2: "x", path_2: "בראשית.txt", line_index_2: 3, "Conection Type": "commentary" }], null, 2);
    await store.openFiles([DB, COMMENTARY, { path: "פירוש על בראשית_links.json", blob: new Blob([strToU8(text)]) }]);
    const id = store.allLinks.value[0]!.id;
    store.deleteLinks([id]);
    expect(store.linkState.value.links.get(id)!.status).toBe("deleted");
    expect((await store.exchange.prepareExport())!.counts.deleted).toBe(1);
    store.undo();
    expect(store.linkState.value.links.get(id)!.status).toBe("existing");
  });
});

describe("AppStore — which book goes in which reader", () => {
  const title = (store: AppStore, side: "source" | "target") => {
    const k = store.view[side].value;
    return k ? store.refOf(k).title : null;
  };

  it("the commentary opened first stays in its reader; the database only fills the empty one (audit F3)", async () => {
    const { store } = makeStore();
    await store.openFiles([COMMENTARY]);
    expect(title(store, "source")).toBe("פירוש על בראשית");
    await store.openFiles([DB]); // the database has its own pair (Onkelos → Bereshit): it must not replace the commentary
    expect(title(store, "source")).toBe("פירוש על בראשית");
    expect(title(store, "target")).toBe("בראשית");
  });

  it("a base opened first keeps its reader; a commentary on it fills the other", async () => {
    const { store } = makeStore();
    await store.openFiles([{ path: "בראשית.txt", blob: new Blob([strToU8("<h1>בראשית</h1>\nבראשית ברא")]) }]);
    await store.openFiles([COMMENTARY]);
    expect(title(store, "source")).toBe("בראשית");
    expect(title(store, "target")).toBe("פירוש על בראשית");
  });

  it("with both readers chosen, opening more books changes neither", async () => {
    const { store } = makeStore();
    await store.openFiles([DB, COMMENTARY]);
    const before = [store.view.source.value, store.view.target.value];
    await store.openFiles([BIUR]);
    expect([store.view.source.value, store.view.target.value]).toEqual(before);
  });
});

describe("AppStore — automatic suggestions", () => {
  it("run → approve all certain (one undo step) → undo returns them to pending → reject is remembered", async () => {
    const { store } = makeStore();
    await store.openFiles([DB, BIUR]);
    const onkelos = [...store.books.value.values()].find((b) => b.title === "ביאור על בראשית")!;
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    expect(await store.suggestions.runEngine("headings", onkelos.key, bereshit.key)).toBe(true);
    const run = store.suggestions.run.value!;
    expect(run.result.suggestions.length).toBe(30);
    const certain = store.suggestions.pendingAtLeast("certain");
    expect(certain.length).toBeGreaterThan(0);

    const before = store.linkState.value.undo.length;
    expect(store.suggestions.approve(certain)).toBe(certain.length);
    expect(store.linkState.value.undo.length).toBe(before + 1);
    expect(store.suggestions.counts.value.approved).toBe(certain.length);
    expect(store.suggestions.approve(certain)).toBe(0); // approving twice creates nothing

    store.undo();
    expect(store.suggestions.counts.value.approved).toBe(0);
    expect(store.suggestions.pendingAtLeast("certain")).toEqual(certain);

    store.suggestions.reject([certain[0]!]);
    expect(store.suggestions.state.value.get(certain[0]!)).toBe("rejected");
    expect(await store.suggestions.runEngine("headings", onkelos.key, bereshit.key)).toBe(true); // a re-run keeps the decision
    expect(store.suggestions.state.value.get(certain[0]!)).toBe("rejected");
  });
});

describe("AppStore — the suggestion table reads like the user's choice", () => {
  it("rows with the same place name differ by the start of the target line (audit F17)", async () => {
    const { store } = makeStore();
    await store.openFiles([DB, BIUR]);
    const biur = [...store.books.value.values()].find((b) => b.title === "ביאור על בראשית")!;
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    expect(await store.suggestions.runEngine("headings", biur.key, bereshit.key)).toBe(true);
    const list = store.suggestions.run.value!.result.suggestions.slice(0, 5);
    expect(store.suggestions.snippet(list[0]!.target)).toBeUndefined(); // not loaded yet
    await store.suggestions.loadPreviews(list);
    const snippets = list.map((s) => store.suggestions.snippet(store.suggestions.display(s).to));
    expect(snippets.every((x) => !!x && x.length > 0)).toBe(true);
    expect(new Set(snippets).size).toBe(list.length);
  });

  it("a dibur hamatchil run stored base → commentary still reads from the commentary the user chose (audit F18)", async () => {
    const { store } = makeStore();
    const verses = ["בראשית ברא אלהים את השמים ואת הארץ.", "והארץ היתה תהו ובהו וחשך על פני תהום.", "ויאמר אלהים יהי אור ויהי אור.", "וירא אלהים את האור כי טוב."];
    const dh = ["בראשית ברא", "תהו ובהו", "יהי אור", "כי טוב"];
    const nl = String.fromCharCode(10);
    // a base that is not a Sefaria book, so nothing but the direction is under test
    const base = { path: "ספר הבסיס.txt", blob: new Blob([strToU8(["<h1>ספר הבסיס</h1>", "<h2>פרק א</h2>", ...verses].join(nl))]) };
    const comm = { path: "ביאור על ספר הבסיס.txt", blob: new Blob([strToU8(["<h1>ביאור על ספר הבסיס</h1>", "<h2>פרק א</h2>", ...dh.map((d, i) => `${d} - ביאור: הסבר קצר על שורה ${i + 1}.`)].join(nl))]) };
    await store.openFiles([base, comm]);
    const c = [...store.books.value.values()].find((b) => b.title === "ביאור על ספר הבסיס")!;
    const b = [...store.books.value.values()].find((x) => x.title === "ספר הבסיס")!;
    expect(await store.suggestions.runEngine("dibur-hamatchil", c.key, b.key)).toBe(true);
    const list = store.suggestions.run.value!.result.suggestions;
    const stored = list.find((s) => s.source.book.key === b.key)!;
    expect(stored).toBeTruthy(); // the engine stores an anchored link from the base
    await store.suggestions.loadPreviews([stored]);
    const v = store.suggestions.display(stored);
    expect(v.reversed).toBe(true);
    expect(v.from.book.key).toBe(c.key);
    expect(v.to.book.key).toBe(b.key);
    expect(v.toLabel).toMatch(/^ספר הבסיס /);
    expect(store.suggestions.snippet(v.to)).toBe(verses[stored.source.line - 2]!.split(" ").slice(0, 7).join(" ") + (verses[stored.source.line - 2]!.split(" ").length > 7 ? "…" : ""));
  });
});

describe("AppStore — projects and autosave", () => {
  it("save → open in a new session binds links to the books by title", async () => {
    const a = makeStore();
    await a.store.openFiles([DB, COMMENTARY]);
    const comm = [...a.store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!;
    const ber = [...a.store.books.value.values()].find((b) => b.title === "בראשית")!;
    await a.store.lines.load(ber.key, 0, 5);
    await a.store.lines.load(comm.key, 0, 2);
    a.store.pickLine("source", comm.key, 1);
    a.store.pickLine("target", ber.key, 2);
    a.store.draftRef2.value = "Genesis 1:1";
    a.store.createFromDraft();
    a.store.saveProject();
    const text = a.saved.at(-1)!.data as string;
    expect(a.store.dirty.value).toBe(false);

    const b = makeStore();
    await b.store.openFiles([{ path: "work.otzlinker.json", blob: new Blob([text]) }]); // before the books: unresolved
    expect(b.store.allLinks.value[0]!.source.book.key).toBe("unresolved:פירוש על בראשית");
    await b.store.openFiles([DB, COMMENTARY]);
    const comm2 = [...b.store.books.value.values()].find((x) => x.title === "פירוש על בראשית")!;
    expect(b.store.linksOfBook(comm2.key)).toHaveLength(1);
    const plan = (await b.store.exchange.prepareExport())!;
    expect(plan.counts).toMatchObject({ new: 1, heldBack: 0 });
  });

  it("a project reopened without its sources lists them by name until they are open again (audit F10)", async () => {
    const a = makeStore();
    await a.store.openFiles([DB, COMMENTARY]);
    const comm = [...a.store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!;
    const ber = [...a.store.books.value.values()].find((b) => b.title === "בראשית")!;
    await a.store.lines.load(ber.key, 0, 5);
    await a.store.lines.load(comm.key, 0, 2);
    a.store.pickLine("source", comm.key, 1);
    a.store.pickLine("target", ber.key, 2);
    a.store.createFromDraft();
    const text = a.store.projectText();
    const stored = JSON.parse(text).sources;
    expect(stored).toEqual([
      { label: "seforim.db", kind: "otzaria-db", books: a.store.sources.value[0]!.books.length, titles: ["בראשית"] },
      { label: "פירוש על בראשית.txt", kind: "text-files", books: 1, files: ["פירוש על בראשית.txt"], titles: ["פירוש על בראשית"] },
    ]);

    const b = makeStore();
    b.store.openProject("work.otzlinker.json", text);
    expect(b.store.missingSources.value.map((s) => [s.label, s.missingTitles])).toEqual([
      ["seforim.db", ["בראשית"]],
      ["פירוש על בראשית.txt", ["פירוש על בראשית"]],
    ]);
    // the success notice points at the list, and does not fade into nothing on its own
    expect(b.store.notices.value.at(-1)!.text).toContain("מקורות וספרים");
    // saving before reopening keeps the sources the project still waits for
    expect(JSON.parse(b.store.projectText()).sources).toEqual(stored);

    await b.store.openFiles([COMMENTARY]);
    expect(b.store.missingSources.value.map((s) => s.label)).toEqual(["seforim.db"]);
    await b.store.openFiles([DB]);
    expect(b.store.missingSources.value).toEqual([]);
  });

  it("an old project's sources (labels only) are missing until a source with that label opens; hiding clears the list", async () => {
    const b = makeStore();
    const old = { format: "otzaria-linker-project", version: 1, savedAt: "", app: "3", sources: [{ label: "seforim.db", kind: "otzaria-db", books: 9, files: [3, "x"], titles: "bad" }], links: [], rejectedSuggestions: [], view: { source: null, target: null } };
    b.store.openProject("old.otzlinker.json", JSON.stringify(old));
    expect(b.store.missingSources.value).toEqual([{ label: "seforim.db", kind: "otzaria-db", books: 9, files: ["x"], missingTitles: [] }]);
    b.store.dismissMissingSources();
    expect(b.store.missingSources.value).toEqual([]);
    b.store.openProject("old.otzlinker.json", JSON.stringify(old));
    await b.store.openFiles([DB]);
    expect(b.store.missingSources.value).toEqual([]);
  });

  it("autosave writes after a change and offers recovery in a new session", async () => {
    const mem = new Map<string, string>();
    const kv = { get: async (k: string) => mem.get(k) ?? null, set: async (k: string, v: string) => void mem.set(k, v), delete: async (k: string) => void mem.delete(k) };
    const a = makeStore();
    a.store.startAutosave(kv, 0);
    await a.store.openFiles([{ path: "פירוש על בראשית_links.json", blob: new Blob([JSON.stringify([{ line_index_1: 2, heRef_2: "x", path_2: "בראשית.txt", line_index_2: 3, "Conection Type": "commentary" }])]) }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(mem.get("autosave:v1")).toContain("otzaria-linker-project");

    const b = makeStore();
    b.store.startAutosave(kv, 0);
    await new Promise((r) => setTimeout(r, 10));
    const offer = b.store.recovery.value!;
    expect(offer.links).toBe(1);
    expect(mem.get("autosave:v1:recovered")).toContain("otzaria-linker-project"); // safe from the next autosave
    offer.restore();
    expect(b.store.allLinks.value).toHaveLength(1);
    expect(b.store.recovery.value).toBeNull();
  });
});

describe("AppStore — batch linking", () => {
  it("pairs every book with the base its title names, runs them all, and summarises per book", async () => {
    const { store } = makeStore();
    await store.openFiles([DB]);
    await store.openFiles([BIUR]);
    expect(await store.suggestions.runBatch("headings", store.sources.value[0]!.info.id)).toBe(true);
    const run = store.suggestions.run.value!;
    const rows = new Map(run.batch!.map((r) => [r.source.title, r]));
    expect(rows.get("תרגום אונקלוס על בראשית")!.target!.title).toBe("בראשית");
    expect(rows.get("תרגום אונקלוס על בראשית")!.certain).toBeGreaterThan(50);
    expect(rows.get("המאיר לארץ על ארצות החיים")!.target!.title).toBe("ארצות החיים");
    expect(rows.get("בראשית")!.problem).toBeTruthy(); // a base book names no base
    expect(run.result.suggestions.length).toBe(run.batch!.reduce((n, r) => n + r.suggestions, 0));
    expect(store.suggestions.counts.value.exists).toBeGreaterThan(50); // the library already has Onkelos
    expect(await store.suggestions.runBatch("headings", store.sources.value[1]!.info.id)).toBe(true);
    expect(store.suggestions.approve(store.suggestions.pendingAtLeast("certain"))).toBe(30);
  });
});

describe("AppStore — rejections survive a saved project", () => {
  it("a suggestion rejected in one session is still rejected after reopening the project", async () => {
    const a = makeStore();
    await a.store.openFiles([DB, BIUR]);
    const key = (s: ReturnType<typeof makeStore>, t: string) => [...s.store.books.value.values()].find((b) => b.title === t)!.key;
    await a.store.suggestions.runEngine("headings", key(a, "ביאור על בראשית"), key(a, "בראשית"));
    const first = a.store.suggestions.pendingAtLeast("certain")[0]!;
    a.store.suggestions.reject([first]);
    a.store.saveProject();

    const b = makeStore();
    await b.store.openFiles([{ path: "p.json", blob: new Blob([a.saved.at(-1)!.data as string]) }, { path: "other-name.db", blob: DB.blob }, BIUR]);
    await b.store.suggestions.runEngine("headings", key(b, "ביאור על בראשית"), key(b, "בראשית"));
    expect(b.store.suggestions.counts.value.rejected).toBe(1);
  });
});

describe("AppStore — suggestions the library already has", () => {
  it("Onkelos → Bereshit links that the database already holds show as 'exists'", async () => {
    const { store } = makeStore();
    await store.openFiles([DB]);
    const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
    await store.suggestions.runEngine("headings", key("תרגום אונקלוס על בראשית"), key("בראשית"));
    expect(store.suggestions.dbLinkKeys.value.size).toBeGreaterThan(0);
    expect(store.suggestions.counts.value.exists).toBeGreaterThan(0);
  });
});

describe("AppStore — moving links to a new edition", () => {
  it("a line inserted at the top shifts every link by one, all certain, in one undo step", async () => {
    const { store } = makeStore();
    const v1 = ["<h1>ספר</h1>", "שורה ראשונה של הספר", "שורה שנייה של הספר", "שורה שלישית של הספר"];
    const v2 = ["<h1>ספר</h1>", "הקדמה חדשה לגמרי", ...v1.slice(1)];
    const links = JSON.stringify([2, 3, 4].map((l) => ({ line_index_1: l, heRef_2: "בסיס", path_2: "בסיס.txt", line_index_2: 1, "Conection Type": "reference" })));
    await store.openFiles([{ path: "ישן/ספר.txt", blob: new Blob([v1.join("\n")]) }, { path: "ספר_links.json", blob: new Blob([links]) }]);
    await store.openFiles([{ path: "חדש/ספר.txt", blob: new Blob([v2.join("\n")]) }]);
    const [oldB, newB] = [...store.books.value.values()];
    expect(await store.planRelinkFor(oldB!.key, newB!.key)).toBe(true);
    const plan = store.relink.value!.plan;
    expect(plan.counts).toEqual({ certain: 3, review: 0, lost: 0 });
    const undoBefore = store.linkState.value.undo.length;
    expect(store.applyRelink(plan.items)).toBe(3);
    expect(store.linkState.value.undo.length).toBe(undoBefore + 1);
    expect(store.allLinks.value.map((l) => [l.source.book.key, l.source.line])).toEqual([[newB!.key, 2], [newB!.key, 3], [newB!.key, 4]]);
  });

  it("the comparison keeps the aligned lines, and the mapping old → new is saved as CSV", async () => {
    const { store, saved } = makeStore();
    const v1 = ["<h1>ספר</h1>", "שורה ראשונה של הספר", "שורה שנייה של הספר"];
    const v2 = ["<h1>ספר</h1>", "הקדמה חדשה לגמרי", ...v1.slice(1)];
    const links = JSON.stringify([{ line_index_1: 2, heRef_2: "בסיס", path_2: "בסיס.txt", line_index_2: 1, "Conection Type": "reference" }]);
    await store.openFiles([{ path: "ישן/ספר.txt", blob: new Blob([v1.join("\n")]) }, { path: "ספר_links.json", blob: new Blob([links]) }]);
    await store.openFiles([{ path: "חדש/ספר.txt", blob: new Blob([v2.join("\n")]) }]);
    const [oldB, newB] = [...store.books.value.values()];
    await store.planRelinkFor(oldB!.key, newB!.key);
    expect(store.relink.value!.rows.map((r) => r.kind)).toEqual(["same", "inserted", "same", "same"]);
    store.saveLineMapping();
    const file = saved.at(-1)!;
    expect(file.name).toMatch(/^מיפוי-שורות-\d{4}-\d\d-\d\d\.csv$/);
    expect((file.data as string).split("\r\n").slice(1, 5)).toEqual(['"1","1","זהה","","same"', '"","2","נוספה","","inserted"', '"2","3","זהה","","same"', '"3","4","זהה","","same"']);
  });
});

describe("AppStore — links from a spreadsheet", () => {
  it("a CSV with a source_title column imports links per book, like links files", async () => {
    const { store } = makeStore();
    const csv = ["source_title,line_index_1,heRef_2,path_2,line_index_2,Conection Type", "פירוש א,2,בראשית א,בראשית.txt,3,source", "פירוש ב,5,בראשית ב,בראשית.txt,7,source"].join(String.fromCharCode(10));
    await store.openFiles([{ path: "links.csv", blob: new Blob([csv]) }]);
    expect(store.allLinks.value.map((l) => l.source.book.title).sort()).toEqual(["פירוש א", "פירוש ב"]);
  });
});
