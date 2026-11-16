import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { EngineId } from "../../../src/linking/automatic";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * V5 P1-10: a saved project reopened after the world moved — the folder was renamed, a source is
 * missing, the app died in the middle of a run. What the user sees, and that every
 * manual decision (approvals, rejections, edits) survives.
 */
function makeStore() {
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(registryService(new SourceRegistry()), { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב", "יג", "יד", "טו", "טז", "יז", "יח", "יט", "כ"][n]!;
const BIUR_LINES = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 20 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()];
const text = (path: string, lines: readonly string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const memKv = () => {
  const mem = new Map<string, string>();
  const kv: KeyValueStore = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k) };
  return { mem, kv };
};
const tick = () => new Promise((r) => setTimeout(r, 15));
const PAIRS: ReadonlySet<EngineId> = new Set(["headings", "dibur-hamatchil", "footnotes"]);

/** a session with decisions of every kind: approved suggestions, one approved then edited, rejections, a manual link */
async function workedOn(folder = "ביאורים") {
  const a = makeStore();
  await a.store.openFiles([DB]);
  await a.store.openFiles([text(`${folder}/ביאור על בראשית.txt`, BIUR_LINES)]);
  const key = (t: string) => [...a.store.books.value.values()].find((b) => b.title === t)!.key;
  await a.store.suggestions.runEngine("headings", key("ביאור על בראשית"), key("בראשית"));
  const certain = a.store.suggestions.pendingAtLeast("certain");
  expect(certain.length).toBeGreaterThanOrEqual(10);
  a.store.suggestions.approve(certain.slice(0, 6));
  a.store.suggestions.reject(certain.slice(6, 9));
  a.store.setType([`auto:${certain[0]}`], "reference");
  return { ...a, key, approved: certain.slice(0, 6), rejected: certain.slice(6, 9) };
}
const decisions = (store: AppStore, ids: { approved: string[]; rejected: string[] }) => ({
  approved: ids.approved.filter((id) => store.suggestions.state.value.get(id) === "approved").length,
  rejected: ids.rejected.filter((id) => store.suggestions.state.value.get(id) === "rejected").length,
  edited: store.allLinks.value.find((l) => l.id === `auto:${ids.approved[0]}`)?.declaredType,
});

describe("reopened from a moved or renamed folder", () => {
  it("the links bind by title, the missing-sources list clears, and the user's \"library books\" switch is kept", async () => {
    const a = await workedOn("ביאורים");
    const folder = a.store.sources.value.find((s) => s.info.kind === "text-files")!;
    a.store.setLibrarySource(folder.info.id, true);
    const project = a.store.projectText();

    const b = makeStore();
    b.store.openProject("p.otzlinker.json", project);
    expect(b.store.missingSources.value.map((s) => s.label)).toEqual(["seforim.db", "ביאורים"]);
    await b.store.openFiles([DB]);
    await b.store.openFiles([text("ביאורים ישנים/ביאור על בראשית.txt", BIUR_LINES)]);
    expect(b.store.missingSources.value).toEqual([]);
    const biur = [...b.store.books.value.values()].find((x) => x.title === "ביאור על בראשית")!;
    expect(b.store.linksOfBook(biur.key)).toHaveLength(6);
    const renamed = b.store.sources.value.find((s) => s.info.kind === "text-files")!;
    expect(renamed.info.label).toBe("ביאורים ישנים");
    // before: the switch was matched by the folder's name and files with it, so a renamed folder lost it
    expect(b.store.isLibrarySource(renamed.info.id)).toBe(true);
    expect(decisions(b.store, a)).toEqual({ approved: 0, rejected: 0, edited: "reference" }); // no run yet: states are per run
  });
});

describe("reopened with a source file missing", () => {
  it("the source is listed to open again; its links are kept, and the export accounts for every one", async () => {
    const a = await workedOn();
    const project = a.store.projectText();
    const b = makeStore();
    await b.store.openFiles([DB]);
    b.store.openProject("p.otzlinker.json", project);
    expect(b.store.missingSources.value.map((s) => [s.label, s.missingTitles])).toEqual([["ביאורים", ["ביאור על בראשית"]]]);
    expect(b.store.allLinks.value).toHaveLength(6);
    const plan = (await b.store.exchange.prepareExport())!;
    expect(plan.written.length + plan.heldBack.length).toBe(6);
    // the commentary's lines could not be checked: every link says so
    const qa = (await b.store.quality.run())!;
    expect(new Set(qa.issues.filter((i) => i.problem.code === "export/line-not-verified").map((i) => i.link.id)).size).toBe(6);
    // and when it is back, the links are on its text again
    await b.store.openFiles([text("ביאורים/ביאור על בראשית.txt", BIUR_LINES)]);
    expect(b.store.missingSources.value).toEqual([]);
    const biur = [...b.store.books.value.values()].find((x) => x.title === "ביאור על בראשית")!;
    expect(b.store.linksOfBook(biur.key)).toHaveLength(6);
  });
});

describe("the app died in the middle of work", () => {
  it("during a max-link run: what was decided before is offered back, and a re-run shows it decided", async () => {
    const { kv } = memKv();
    const a = await workedOn();
    a.store.startAutosave(kv, 0);
    a.store.setType([`auto:${a.approved[1]}`], "commentary"); // one more change, so the autosave runs
    await tick();
    const folder = a.store.sources.value.find((s) => s.info.kind === "text-files")!;
    const scope = { kind: "source", id: folder.info.id } as const;
    // the run starts, and the tab dies before it ends: nothing of the run is kept, nothing before it is lost
    void a.store.maxLink.run(a.store.maxLink.plan(scope, PAIRS), "תיקייה");

    const b = makeStore();
    b.store.startAutosave(kv, 0);
    await tick();
    expect(b.store.recovery.value!.links).toBe(6 + 3);
    b.store.recovery.value!.restore();
    await b.store.openFiles([DB]);
    await b.store.openFiles([text("ביאורים/ביאור על בראשית.txt", BIUR_LINES)]);
    const folder2 = b.store.sources.value.find((s) => s.info.kind === "text-files")!;
    expect(await b.store.maxLink.run(b.store.maxLink.plan({ kind: "source", id: folder2.info.id }, PAIRS), "תיקייה")).toBe(true);
    const st = b.store.suggestions.state.value;
    const sugs = b.store.suggestions.run.value!.result.suggestions;
    // the approved links are "already in the project", the rejected suggestions still rejected
    expect(sugs.filter((s) => st.get(s.id) === "exists" || st.get(s.id) === "approved").length).toBeGreaterThanOrEqual(6);
    expect(sugs.filter((s) => st.get(s.id) === "rejected").length).toBe(3);
    expect(b.store.allLinks.value.find((l) => l.id === `auto:${a.approved[0]}`)!.declaredType).toBe("reference");
    expect(b.store.allLinks.value.find((l) => l.id === `auto:${a.approved[1]}`)!.declaredType).toBe("commentary");
  });

  it("an offer to restore that was neither taken nor dismissed is offered again at the next start", async () => {
    const { kv, mem } = memKv();
    const a = await workedOn();
    a.store.startAutosave(kv, 0);
    a.store.setType([`auto:${a.approved[1]}`], "commentary");
    await tick();

    // the next start: the offer is shown, and the user goes to work on something else instead
    const b = makeStore();
    b.store.startAutosave(kv, 0);
    await tick();
    expect(b.store.recovery.value!.links).toBe(9);
    await b.store.openFiles([DB]);
    await b.store.openFiles([text("אחר.txt", ["<h1>אחר</h1>", "שורה", "שורה"])]);
    const other = [...b.store.books.value.values()].find((x) => x.title === "אחר")!;
    const ber = [...b.store.books.value.values()].find((x) => x.title === "בראשית")!;
    await b.store.lines.load(other.key, 0, 3);
    await b.store.lines.load(ber.key, 0, 5);
    b.store.pickLine("source", other.key, 1);
    b.store.pickLine("target", ber.key, 2);
    b.store.createFromDraft();
    await tick();
    expect(JSON.parse(mem.get("autosave:v1")!).links).toHaveLength(1);

    // the start after that: the new work first, and the earlier work is still there to restore
    const c = makeStore();
    c.store.startAutosave(kv, 0);
    await tick();
    expect(c.store.recovery.value!.links).toBe(1);
    c.store.recovery.value!.dismiss();
    // before: the earlier work stayed in storage where nothing offered it again
    expect(c.store.recovery.value!.links).toBe(9);
    c.store.recovery.value!.restore();
    expect(c.store.allLinks.value).toHaveLength(6);
    expect(c.store.linkState.value.rejected.size).toBeGreaterThanOrEqual(3);
    expect(mem.has("autosave:v1:recovered")).toBe(false);
  });
});
