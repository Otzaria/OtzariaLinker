import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * V7 §2.8, #41 B4, end to end: a batch run against a base open in two editions. Folder A holds the commentary and one "בסיס";
 * folder B holds another "בסיס". The batch pairs the commentary with folder A's (its own source) — a rule, not evidence — so
 * nothing it finds is above "possible", the summary row and the run say why, and choosing the source lifts the cap.
 * The books are minimal hand-written text files (two chapters under matching headings); no schema is involved.
 */
const NL = String.fromCharCode(10);
const text = (path: string, lines: readonly string[]) => ({ path, blob: new Blob([strToU8(lines.join(NL))]) });
// Two editions: the same headings, other text (two byte-identical files are one file, opened once — V3 F-016)
const base = (path: string, edition = "") =>
  text(path, ["<h1>בסיס</h1>", "<h2>פרק א</h2>", `שורה ראשונה${edition}`, "<h2>פרק ב</h2>", `שורה שנייה${edition}`, "<h2>פרק ג</h2>", `שורה שלישית${edition}`]);
const COMM = () => text("a/ביאור על בסיס.txt", ["<h1>ביאור על בסיס</h1>", "<h2>פרק א</h2>", "ביאור ראשון", "<h2>פרק ב</h2>", "ביאור שני", "<h2>פרק ג</h2>", "ביאור שלישי"]);

async function opened() {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
  await store.openFiles([COMM(), base("a/בסיס.txt")]);
  await store.openFiles([base("b/בסיס.txt", " (מהדורה ב)")]);
  return store;
}

describe("batch linking against a base open in two editions (V7 §2.8, #41 B4)", () => {
  it("a base chosen by a rule: nothing above 'possible', and the row and the run say why", async () => {
    const store = await opened();
    const folder = store.sources.value[0]!.info.id;
    expect(await store.suggestions.runBatch("headings", folder)).toBe(true);
    const run = store.suggestions.run.value!;
    const row = run.batch!.find((r) => r.source.title === "ביאור על בסיס")!;
    expect(row.target?.key.startsWith(`${folder}:`)).toBe(true);
    expect(row.suggestions).toBeGreaterThan(0);
    expect(row.certain + row.high).toBe(0);
    expect(row.note).toContain("אפשרית");
    expect(run.result.suggestions.every((s) => s.confidence !== "certain" && s.confidence !== "high")).toBe(true);
    expect(run.result.notes.some((n) => n.code === "batch/undecided-base")).toBe(true);
  });

  it("the source the user chose for the bases decides: the suggestions keep their confidence", async () => {
    const store = await opened();
    const [a, b] = store.sources.value.map((s) => s.info.id);
    expect(await store.suggestions.runBatch("headings", a!, {}, { preferSource: b! })).toBe(true);
    const run = store.suggestions.run.value!;
    const row = run.batch!.find((r) => r.source.title === "ביאור על בסיס")!;
    expect(row.target?.key.startsWith(`${b}:`)).toBe(true);
    expect(row.certain + row.high).toBeGreaterThan(0);
    expect(run.result.notes.some((n) => n.code === "batch/undecided-base")).toBe(false);
  });
});
