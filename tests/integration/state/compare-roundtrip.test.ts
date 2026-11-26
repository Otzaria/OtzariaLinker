import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { linePairIdentity } from "../../../src/core/links/equality";
import type { Link } from "../../../src/core/links/model";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * V7 §1.7, the round trip of comparing and merging (AGENTS.md §3: an untouched imported file is written back
 * byte-identical). For random links files of one book — key order, spacing of the references, the type's
 * spelling, unknown pipeline fields, Python's float line numbers and the library's layouts — through the
 * store, as a user does it:
 *
 *   import A → export: the bytes of A, exactly;
 *   import A → compare with B → merge (the project is the base) → export → read the exported file back →
 *   compare it with the project: nothing differs, and nothing is even "written differently" — every link the
 *   export wrote is the very record the project holds, and the export held nothing back.
 *
 * No database is open: the books are known by title only, so nothing hangs on a line being there.
 */
const SOURCE = "ספר המקור";
const FILE = `${SOURCE}_links.json`;
const TARGETS = ["ספר א", "ספר ב"];

const record = fc
  .record({
    li1: fc.integer({ min: 1, max: 12 }),
    li2: fc.integer({ min: 1, max: 12 }),
    end2: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
    target: fc.constantFrom(...TARGETS),
    type: fc.constantFrom("commentary", "reference", "other", "COMMENTARY", "targum", " Reference "),
    heRef: fc.constantFrom("א 5", "א  5", "ב, ג", "שם‏ המקום"),
    ref1: fc.option(fc.constantFrom("Genesis 1:1", "Genesis 1:1 "), { nil: undefined }),
    ref2: fc.option(fc.constantFrom("Rashi on Genesis 1:1:1"), { nil: undefined }),
    anchor: fc.option(fc.tuple(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 1, max: 9 })), { nil: undefined }),
    extra: fc.option(fc.constantFrom("ctx-a", "ctx-b"), { nil: undefined }),
    order: fc.integer({ min: 0, max: 5 }),
  })
  .map((r) => {
    const fields: [string, unknown][] = [
      ["line_index_1", r.li1],
      ["heRef_2", `${r.target} ${r.heRef}`],
      ["path_2", `${r.target}.txt`],
      ["line_index_2", r.li2],
      ...(r.end2 !== undefined ? [["line_index_2_end", r.li2 + r.end2] as [string, unknown]] : []),
      ...(r.anchor ? [["start", r.anchor[0]] as [string, unknown], ["end", r.anchor[0] + r.anchor[1]] as [string, unknown]] : []),
      ...(r.ref1 !== undefined ? [["ref_1", r.ref1] as [string, unknown]] : []),
      ...(r.ref2 !== undefined ? [["ref_2", r.ref2] as [string, unknown]] : []),
      ["Conection Type", r.type],
      ...(r.extra !== undefined ? [["anchor_context", r.extra] as [string, unknown]] : []),
    ];
    // another key order for some records: rotate the fields
    const k = r.order % fields.length;
    return Object.fromEntries(r.order > 2 ? [...fields.slice(k), ...fields.slice(0, k)] : fields);
  });

type Layout = "js2" | "compact" | "python";
/** the layouts library files are written in (formats/links-json/layout.ts) */
function write(records: readonly Record<string, unknown>[], layout: Layout): string {
  if (layout === "compact") return JSON.stringify(records);
  if (layout === "js2") return JSON.stringify(records, null, 2);
  // Python json.dump(indent=4) of float line numbers, with a final newline
  return `${JSON.stringify(records, null, 4).replace(/("line_index_[12](?:_end)?": )(\d+)/g, "$1$2.0")}\n`;
}

/** B: A with some records dropped, some changed (another target line, type, reference or ref), and new ones */
const version = (a: readonly Record<string, unknown>[]) =>
  fc.tuple(fc.array(fc.constantFrom("keep", "drop", "line", "type", "heRef", "ref"), { minLength: a.length, maxLength: a.length }), fc.array(record, { maxLength: 4 })).map(([ops, extra]) => [
    ...a.flatMap((r, i): Record<string, unknown>[] => {
      const op = ops[i];
      if (op === "drop") return [];
      if (op === "line") return [{ ...r, line_index_2: (r.line_index_2 as number) + 20 }];
      if (op === "type") return [{ ...r, "Conection Type": "reference" === r["Conection Type"] ? "commentary" : "reference" }];
      if (op === "heRef") return [{ ...r, heRef_2: `${r.heRef_2 as string} (ב)` }];
      if (op === "ref") return [{ ...r, ref_1: "Exodus 2:2" }];
      return [r];
    }),
    ...extra,
  ]);

const fresh = () => {
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(registryService(new SourceRegistry()), { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  store.exportPurpose.value = "private";
  return store;
};

async function exported(store: AppStore): Promise<{ text: string; held: Link[] }> {
  const plan = (await store.exchange.prepareExport())!;
  const file = plan.files.find((f) => f.name === FILE)!;
  return { text: file.text, held: plan.heldBack.map((h) => h.link) };
}

const input = fc.tuple(fc.array(record, { minLength: 1, maxLength: 8 }), fc.constantFrom<Layout>("js2", "compact", "python")).chain(([a, layout]) => fc.tuple(fc.constant(a), version(a), fc.constant(layout), fc.constantFrom<Layout>("js2", "compact", "python")));

describe("compare → merge → export → read back → compare: no differences (V7 §1.7)", () => {
  it("property: an untouched imported file exports byte-identical", async () => {
    await fc.assert(
      fc.asyncProperty(input, async ([a, , layout]) => {
        const text = write(a, layout);
        const store = fresh();
        store.exchange.importLinksFile(FILE, text);
        const out = await exported(store);
        expect(out.held).toEqual([]);
        expect(out.text).toBe(text);
      }),
      { numRuns: 200 },
    );
  }, 60_000);

  it("property: the merged project, exported and read back, compares identical to itself", async () => {
    await fc.assert(
      fc.asyncProperty(input, async ([a, b, layoutA, layoutB]) => {
        const store = fresh();
        store.exchange.importLinksFile(FILE, write(a, layoutA));
        store.compare.addFiles([{ path: `b/${FILE}`, text: write(b, layoutB) }]);
        // compare: the project against B is a full account of both sides
        const d = store.compare.compare(SOURCE, "project", "file:0")!;
        expect(d.rows.filter((r) => r.a).length).toBe(a.length);
        expect(d.rows.filter((r) => r.b).length).toBe(b.length);
        // merge with the project as the base, conflicts left out; then export and read the file back
        store.compare.applyMerge(SOURCE, ["project", "file:0"], "project", false);
        // the merge never takes in a second record of two lines the project already holds (it is a conflict, left out)
        const lines = store.allLinks.value.filter((l) => l.provenance === "file").map(linePairIdentity);
        for (const l of store.allLinks.value.filter((x) => x.provenance === "import")) {
          expect(lines).not.toContain(linePairIdentity(l));
          lines.push(linePairIdentity(l));
        }
        const out = await exported(store);
        // V7 §1.9: exporting again, with nothing changed, gives the same bytes
        expect((await exported(store)).text).toBe(out.text);
        // a library record is never held back; a merged-in new link may be (a ref on a book that is not Sefaria's…), with its reason
        expect(out.held.filter((l) => l.provenance === "file")).toEqual([]);
        store.compare.addFiles([{ path: `out/${FILE}`, text: out.text }]);
        const outSet = store.compare.setsOf(SOURCE).find((s) => s.name === `out/${FILE}`)!;
        const back = store.compare.compare(SOURCE, "project", outSet.id)!;
        // every link written reads back as the very same record; only the held-back ones are missing from the file
        const held = new Set(out.held.map((l) => l.id));
        expect(back.rows.filter((r) => r.kind !== "same").map((r) => [r.kind, held.has(r.a?.id ?? "")])).toEqual(out.held.map(() => ["removed", true]));
        expect(back.equivalent).toBe(0);
        expect(back.rows.length).toBe(store.allLinks.value.length);
        // and exporting the read-back file once more gives its bytes again
        const again = fresh();
        again.exchange.importLinksFile(FILE, out.text);
        expect((await exported(again)).text).toBe(out.text);
      }),
      { numRuns: 200 },
    );
  }, 60_000);
});
