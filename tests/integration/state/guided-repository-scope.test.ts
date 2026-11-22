import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * The guided flow started from the repository analysis (V6 3.9): the books are ones of an open database, chosen one by one, not a
 * source; the pairs the user chose are the only way those books are linked.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };

async function ready() {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
  await store.openFiles([DB]);
  const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
  return { store, g: store.guided, key };
}
const COMM = "המאיר לארץ על ארצות החיים";

describe("guided flow — started from books of an open database", () => {
  it("plans exactly the chosen books, goes to the books step, and the flow is not tied to a source", async () => {
    const { store, g, key } = await ready();
    g.startForBooks([key(COMM)], []);
    expect(store.screen.value).toBe("guided");
    expect(g.step.value).toBe("books");
    expect(g.bookSources.value).toEqual([]);
    expect(g.plan.value!.books.map((b) => b.book.title)).toEqual([COMM]);
    expect(g.facts.value.books).toBe(1);
  });

  it("the chosen pairs are the only relations of their dependant", async () => {
    const { g, key } = await ready();
    g.startForBooks([key(COMM)], [{ dependant: COMM, base: "בראשית", dependantKey: key(COMM), baseKey: key("בראשית") }]);
    const pairs = g.plan.value!.steps.filter((s) => s.kind === "pair").map((s) => `${s.relation.dependant.title}>${s.relation.base.title}`);
    expect(new Set(pairs)).toEqual(new Set([`${COMM}>בראשית`]));
  });

  it("choosing files for the flow, or starting it again, drops the books of the analysis", async () => {
    const { g, key } = await ready();
    g.startForBooks([key(COMM)], []);
    g.start();
    expect(g.repoScope.value).toBeNull();
    expect(g.plan.value).toBeNull();
  });

  it("the controls of a pair (switched off, link type) still apply to a pair the user chose in the analysis", async () => {
    const { g, key } = await ready();
    g.startForBooks([key(COMM)], [{ dependant: COMM, base: "בראשית", dependantKey: key(COMM), baseKey: key("בראשית") }]);
    const pairs = () => g.plan.value!.steps.filter((s) => s.kind === "pair").map((s) => `${s.relation.dependant.title}>${s.relation.base.title}`);
    expect(pairs().length).toBeGreaterThan(0);
    g.setPairControl(COMM, "בראשית", { connectionType: "targum" });
    const typed = g.plan.value!.steps.filter((s) => s.kind === "pair");
    expect(typed.every((s) => s.options?.declaredType === "targum")).toBe(true);
    g.setPairControl(COMM, "בראשית", { enabled: false });
    expect(pairs()).toEqual([]);
    expect(g.plan.value!.unsuitable.some((u) => u.reason === "disabled")).toBe(true);
  });
});
