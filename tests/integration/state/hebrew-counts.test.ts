import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * #41 B27: the counts of one in Hebrew — "נפתחו ספר אחד" (verb in plural, noun in singular), "1 קישורים",
 * "1 קבצים ומסדים", "מראי מקומות: מראי מקומות:" twice. One is "נפתח ספר אחד"; many stay as they were.
 */
const newStore = () => new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });

describe("Hebrew counts of one (B27)", () => {
  it("one book opened: the verb agrees with it", async () => {
    const store = newStore();
    await store.openFiles([text("ספר.txt", ["<h1>ספר</h1>", "שורה"])]);
    const said = store.notices.value.at(-1)!.text;
    expect(said).toContain("נפתח ספר אחד");
    expect(said).not.toContain("נפתחו ספר");
  });

  it("two books: as before", async () => {
    const store = newStore();
    await store.openFiles([text("א.txt", ["<h1>א</h1>"]), text("ב.txt", ["<h1>ב</h1>"])]);
    expect(store.notices.value.at(-1)!.text).toContain("נפתחו 2 ספרים");
  });

  it("the citations run is not labelled with the engine's name twice", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/state/suggestions.ts", "utf8");
    // the panel shows "<engine title>: <run label>" (suggestions-panel.tsx); the label must not repeat the title
    expect(src).not.toMatch(/label: `מראי מקומות: /);
  });
});
