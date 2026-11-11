import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { SourceRegistry } from "../../../src/sources/registry";

/* The mapping wizard's state flow, without UI: drop → pending → open through a mapping → saved in the project → reused. */
function makeStore(reg = new SourceRegistry()) {
  const service = {
    open: (f) => reg.open(f),
    openMapped: (t, m) => reg.openMapped(t, m),
    lines: (k, a, b) => reg.lines(k, a, b),
    existingLinks: (k, a, b) => reg.existingLinks(k, a, b),
    close: async (id) => reg.close(id),
  } as BooksService;
  return new AppStore(service, { save: () => {} }, loadPreferences(null));
}
const DB = () => ({ path: "corpus.db", blob: new Blob([readFileSync("tests/fixtures/db/generic/books-lines.db")]) });

describe("AppStore — databases in someone else's schema", () => {
  it("a dropped database waits for the wizard; confirming opens it and remembers the mapping", async () => {
    const store = makeStore();
    await store.openFiles([DB()]);
    expect(store.sources.value).toEqual([]);
    const [p] = store.pendingDbs.value;
    expect(p!.guess).not.toBeNull();

    expect(await store.openMapped(p!, p!.guess!)).toBe(true);
    expect(store.pendingDbs.value).toEqual([]);
    expect(store.sources.value.map((s) => s.info.kind)).toEqual(["mapped-db"]);
    expect(store.screen.value).toBe("workspace");
    // commentary ← base, chosen from the titles like any other source
    expect(store.refOf(store.view.source.value!).title).toBe("פירוש על ספר הדוגמה");
    expect(store.refOf(store.view.target.value!).title).toBe("ספר הדוגמה");
    expect([...store.dbMappings.value.keys()]).toEqual([p!.preview.fingerprint]);
    expect(store.canRemap(store.sources.value[0]!.info.id)).toBe(true);
    expect(JSON.parse(store.projectText()).dbMappings).toEqual([{ fingerprint: p!.preview.fingerprint, label: "corpus.db", mapping: p!.guess }]);
  });

  it("a failed open keeps the wizard open with an error notice", async () => {
    const store = makeStore();
    await store.openFiles([DB()]);
    const p = store.pendingDbs.value[0]!;
    expect(await store.openMapped(p, { ...p.guess!, lines: { ...p.guess!.lines, text: "missing" } })).toBe(false);
    expect(store.pendingDbs.value).toHaveLength(1);
    expect(store.notices.value.at(-1)).toMatchObject({ kind: "error" });
  });

  it("a project that holds the mapping opens the same database without asking", async () => {
    const first = makeStore();
    await first.openFiles([DB()]);
    const p = first.pendingDbs.value[0]!;
    const custom = { ...p.guess!, links: undefined };
    delete custom.links;
    await first.openMapped(p, custom);
    const project = first.projectText();

    const second = makeStore();
    second.openProject("work.otzlinker.json", project);
    await second.openFiles([DB()]);
    expect(second.pendingDbs.value).toEqual([]);
    expect(second.sources.value[0]!.books).toHaveLength(3);
    expect(second.notices.value.some((n) => n.text.includes("המיפוי השמור"))).toBe(true);
  });

  it("dismissing drops the pending database; re-mapping reopens the wizard with the current mapping", async () => {
    const store = makeStore();
    await store.openFiles([DB()]);
    store.dismissMapping(store.pendingDbs.value[0]!.token);
    expect(store.pendingDbs.value).toEqual([]);

    await store.openFiles([DB()]);
    const p = store.pendingDbs.value[0]!;
    await store.openMapped(p, { ...p.guess!, lines: { ...p.guess!.lines, heading: undefined } });
    await store.remapSource(store.sources.value[0]!.info.id);
    expect(store.sources.value).toEqual([]);
    expect(store.pendingDbs.value[0]!.guess!.lines.heading).toBeUndefined();
    expect(await store.openMapped(store.pendingDbs.value[0]!, p.guess!)).toBe(true); // the token is still valid
  });
});
