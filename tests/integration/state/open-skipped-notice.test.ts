import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/* What the user is told when files are not opened: a Hebrew count ("קובץ אחד", never "1 קבצים") and an honest reason (an empty file is empty). */
const makeStore = () => new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
const text = (path: string) => ({ path, blob: new Blob([strToU8("שלום עולם")]) });

describe("files that were not opened", () => {
  it("one file is said in the singular", async () => {
    const store = makeStore();
    await store.openFiles([text("notes.xyz")]);
    const n = store.notices.value.find((x) => x.kind === "warning")!;
    expect(n.text).toBe("קובץ אחד לא נפתח.");
  });

  it("several are counted in Hebrew plural", async () => {
    const store = makeStore();
    await store.openFiles([text("a.xyz"), text("b.xyz")]);
    expect(store.notices.value.find((x) => x.kind === "warning")!.text).toBe("2 קבצים לא נפתחו.");
  });

  it("an empty file is said to be empty, not 'a text file that is not .txt'", async () => {
    const store = makeStore();
    await store.openFiles([{ path: "empty.db", blob: new Blob([]) }, text("notes.xyz")]);
    const n = store.notices.value.find((x) => x.kind === "warning")!;
    expect(n.details).toContain("empty.db: הקובץ ריק (אין בו אף בייט).");
    expect(n.details!.some((d) => d.startsWith("notes.xyz:") && d.includes("שאינו"))).toBe(true);
    expect(n.details!.join("\n")).not.toMatch(/empty\.db:.*שאינו/);
  });
});

describe("the notice of files that did not open stays (#41 B24)", () => {
  it("is sticky", async () => {
    const { AppStore } = await import("../../../src/state/store");
    const { SourceRegistry } = await import("../../../src/sources/registry");
    const { loadPreferences } = await import("../../../src/state/preferences");
    const { registryService } = await import("../../support/books-service");
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
    await store.openFiles([{ path: "seforim.db", blob: new Blob([new Uint8Array(4096).fill(7)]) }]);
    const n = store.notices.value.find((x) => x.text.includes("לא נפתח"))!;
    expect(n.sticky).toBe(true);
    expect(n.details!.join(" ")).toContain("מסד SQLite");
  });
});
