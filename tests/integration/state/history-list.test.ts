import { describe, expect, it } from "vitest";
import { timeline } from "../../../src/state/history";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

const rec = (l1: number, l2: number) => ({ line_index_1: l1, heRef_2: `ב ${l2}`, path_2: "ב.txt", line_index_2: l2, "Conection Type": "commentary" });

describe("AppStore — the history list", () => {
  it("labels read as Hebrew, with counts; going to an entry undoes or redoes to it", () => {
    const store = new AppStore({} as BooksService, { save: () => {} }, loadPreferences(null));
    store.importLinksFile("א_links.json", JSON.stringify([rec(1, 1)]));
    store.importLinksFile("ג_links.json", JSON.stringify([rec(1, 1), rec(2, 2)]));
    const ids = store.allLinks.value.filter((l) => l.source.book.title === "ג").map((l) => l.id);
    store.deleteLinks(ids);
    store.restoreLinks(ids);
    store.setType(ids, "reference");
    expect(timeline(store.linkState.value).map((e) => e.label)).toEqual([
      "ייבוא א_links.json (קישור אחד)",
      "ייבוא ג_links.json (2 קישורים)",
      "מחיקת 2 קישורים",
      "שחזור 2 קישורים",
      "שינוי סוג הקשר של 2 קישורים",
    ]);

    store.goToHistory(1);
    expect(store.allLinks.value).toHaveLength(1);
    expect(timeline(store.linkState.value).filter((e) => e.applied)).toHaveLength(1);
    store.goToHistory(5);
    expect(store.allLinks.value.filter((l) => l.declaredType === "reference")).toHaveLength(2);
    store.goToHistory(0);
    expect(store.allLinks.value).toHaveLength(0);
    expect(store.dirty.value).toBe(true);
  });
});
