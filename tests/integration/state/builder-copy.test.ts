import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * V7 §3.10: copying a link in the visual editor — an edited link saved as an ADDITIONAL link (another target for the same source),
 * the original kept; one undoable action; an unchanged copy (the same lines) is refused, as it would be a duplicate.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const COMMENTARY = { path: "פירוש על בראשית.txt", blob: new Blob([strToU8("<h1>פירוש על בראשית</h1>\nבראשית - פירוש ראשון\nויאמר - פירוש שני")]) };

describe("the builder: a link copied as a new one", () => {
  it("keeps the original, adds the copy with the new target, and undoes in one step", async () => {
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
    await store.openFiles([DB, COMMENTARY]);
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    const comm = [...store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!;
    await store.lines.load(bereshit.key, 0, 10);
    await store.lines.load(comm.key, 0, 2);
    const verses = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => store.lines.peek(bereshit.key, i)!.heading === null);
    store.pickLine("source", comm.key, 1);
    store.pickLine("target", bereshit.key, verses[0]!);
    const first = store.createFromDraft()!;

    store.editInBuilder(first.id);
    // unchanged: a copy would be the same link twice
    expect(store.createFromDraft({ asNew: true })).toBeNull();
    expect(store.allLinks.value).toHaveLength(1);

    store.pickLine("target", bereshit.key, verses[1]!);
    const copy = store.createFromDraft({ asNew: true })!;
    expect(copy.id).not.toBe(first.id);
    expect(copy).toMatchObject({ status: "new", provenance: "user", source: { line: 1 }, target: { line: verses[1] } });
    expect(store.linkState.value.links.get(first.id)).toMatchObject({ target: { line: verses[0] }, status: "new" });
    expect(store.allLinks.value).toHaveLength(2);
    expect(store.editing.value).toBeNull();
    // the source stays picked: another target for the same line is one more pick away
    expect(store.pick.source.value).toMatchObject({ bookKey: comm.key, line: 1 });
    store.undo();
    expect(store.allLinks.value.map((l) => l.id)).toEqual([first.id]);
  });

  it("a copy of an imported, continued record is a clean new link: none of the record's file, merge or continuation fields", async () => {
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
    await store.openFiles([DB, COMMENTARY]);
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    const comm = [...store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!;
    await store.lines.load(bereshit.key, 0, 10);
    await store.lines.load(comm.key, 0, 3);
    const verses = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => store.lines.peek(bereshit.key, i)!.heading === null);
    // a library record as the file spells it: a folder in path_2, a null type, a pipeline field, a fractional line `.5` (its own text is kept)
    const text = `[\n  {\n    "line_index_1": 2,\n    "heRef_2": "בראשית",\n    "path_2": "תורה/בראשית.txt",\n    "line_index_2": ${verses[0]! + 1}.5,\n    "Conection Type": null,\n    "anchor_src_hash": "sha256:abc"\n  }\n]`;
    store.exchange.importLinksFile("פירוש על בראשית_links.json", text);
    const rec = store.allLinks.value[0]!;
    expect(rec).toMatchObject({ status: "existing", provenance: "file", typeNull: true, targetPath: "תורה/בראשית.txt", fileIndex: 0, passthrough: { anchor_src_hash: "sha256:abc" } });
    expect(rec.fileText).toBeDefined();
    expect(rec.keyOrder).toBeDefined();
    // the next line continues it: the record's range grows, and the continuation remembers it was an untouched library record
    expect(store.ranges.applyContinue((await store.ranges.planContinue(comm.key, "source", 2))!)).toBe(1);
    const ext = store.linkState.value.links.get(rec.id)!;
    expect(ext.continued).toMatchObject({ kind: "extend", baseStatus: "existing" });

    store.editInBuilder(rec.id);
    store.pickLine("target", bereshit.key, verses[1]!);
    store.draftType.value = "commentary";
    const copy = store.createFromDraft({ asNew: true })!;
    expect(copy).toMatchObject({ status: "new", provenance: "user", declaredType: "commentary", target: { line: verses[1] } });
    for (const f of ["continued", "fileIndex", "fileText", "origins", "passthrough", "keyOrder", "typeNull", "targetPath", "restoreStatus", "matched"] as const) {
      expect(copy[f], f).toBeUndefined();
    }
    // the copy is not a continuation: cancelling one on it neither removes it nor turns it into a library record
    expect(store.ranges.cancelContinuation([copy.id])).toBe(0);
    expect(store.linkState.value.links.get(copy.id)).toMatchObject({ status: "new" });
    // the original is untouched
    expect(store.linkState.value.links.get(rec.id)).toBe(ext);
  });
});
