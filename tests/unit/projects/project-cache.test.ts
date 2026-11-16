import { describe, expect, it } from "vitest";
import type { Link } from "../../../src/core/links/model";
import { serializeProject } from "../../../src/projects/project-format";
import { addChanges, commit, editChange } from "../../../src/state/history";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

/*
 * Review C18: every edit serialized the whole project on the UI thread (220–350 ms for 112,905 links).
 * Links are immutable objects, so their JSON is kept by object: an autosave after one edit serializes
 * that one link. Asserted as work (links serialized), not wall-clock; the timings are in the commit.
 */
const link = (i: number): Link => ({
  id: `u:${i}`,
  status: "new",
  provenance: i % 7 === 0 ? "db" : "auto",
  source: { book: { key: `unresolved:פירוש ${i % 5}`, title: `פירוש ${i % 5}`, origin: "otzaria" }, line: i, ...(i % 4 === 0 && { end: i + 2 }) },
  target: { book: { key: "s1:9", title: 'משנה "ברורה"', origin: "otzaria", isBaseBook: true }, line: i * 2 },
  declaredType: "commentary",
  heRef2: `סימן ${i}`,
  ...(i % 3 === 0 && { anchor: { rawStart: 1, rawEnd: 4 } }),
});
const base = { sources: [{ label: '"links":[] x', kind: "otzaria-db" as const, books: 1 }], rejectedSuggestions: ["a"], view: { source: null, target: null } };

class CountingCache extends WeakMap<Link, string> {
  sets = 0;
  override set(k: Link, v: string): this {
    this.sets++;
    return super.set(k, v);
  }
}

describe("project text with a per-link cache (review C18)", () => {
  it("is byte-identical to the uncached text, and serializes only the links that changed", () => {
    const at = new Date(0);
    const links = Array.from({ length: 500 }, (_, i) => link(i));
    const cache = new CountingCache();
    expect(serializeProject({ ...base, links }, "x", at, cache)).toBe(serializeProject({ ...base, links }, "x", at));
    const kept = links.filter((l) => l.provenance !== "db").length;
    expect(cache.sets).toBe(kept);
    const edited = links.map((l, i) => (i === 10 ? { ...l, declaredType: "reference" } : l));
    expect(serializeProject({ ...base, links: edited }, "x", at, cache)).toBe(serializeProject({ ...base, links: edited }, "x", at));
    expect(cache.sets).toBe(kept + 1);
    expect(serializeProject({ ...base, links: [] }, "x", at, cache)).toBe(serializeProject({ ...base, links: [] }, "x", at));
  });

  it("autosave writes once per new revision, not when the links only bind to opened books", async () => {
    const store = new AppStore({} as BooksService, { save: () => {} }, loadPreferences(null));
    const writes: string[] = [];
    const kv: KeyValueStore = { get: async () => null, set: async (_k, v) => void writes.push(v), delete: async () => {} };
    const stop = store.startAutosave(kv, 0);
    const tick = () => new Promise((r) => setTimeout(r, 5));
    store.linkState.value = commit(store.linkState.value, "x", addChanges([link(1), link(2)]));
    await tick();
    expect(writes).toHaveLength(1);
    // same revision, new state object (what attachLinks does): nothing to write
    store.linkState.value = { ...store.linkState.value };
    await tick();
    expect(writes).toHaveLength(1);
    store.linkState.value = commit(store.linkState.value, "e", [editChange(store.linkState.value, "u:1", { declaredType: "reference" })!]);
    await tick();
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1]!).links.find((l: Link) => l.id === "u:1").declaredType).toBe("reference");
    stop();
  });
});
