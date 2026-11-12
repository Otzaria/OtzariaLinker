import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Product audit F6 (scenarios 7 and 11): links files loaded BEFORE their books — the order the guided
 * task "עריכת קישורים קיימים" asks for. When the books open the links attach to them: the quality check
 * finds the books, and a link past the end of a 12-line book reports 12 lines, not a phantom 800.
 */
const GEN1 = ["בראשית ברא אלהים את השמים ואת הארץ.", "והארץ היתה תהו ובהו וחשך על פני תהום.", "ויאמר אלהים יהי אור ויהי אור.", "וירא אלהים את האור כי טוב.", "ויקרא אלהים לאור יום.", "ויאמר אלהים יהי רקיע.", "ויעש אלהים את הרקיע.", "ויקרא אלהים לרקיע שמים.", "ויאמר אלהים יקוו המים.", "ויקרא אלהים ליבשה ארץ."];
const BASE = ["<h1>בראשית</h1>", "<h2>פרק א</h2>", ...GEN1]; // 12 lines
const COMM = ["<h1>ביאור קצר על בראשית</h1>", "<h2>פרק א</h2>", ...[0, 1, 2, 3, 4].flatMap((i) => [`<h3>פסוק ${i + 1}</h3>`, `פירוש קצר ${i + 1}.`])];
const file = (path: string, text: string) => ({ path, blob: new Blob([strToU8(text)]) });
const rec = (l1: number, l2: number) => ({ line_index_1: l1, line_index_2: l2, heRef_2: "בראשית א", path_2: "בראשית.txt", "Conection Type": "commentary" });
const LINKS = file("links/ביאור קצר על בראשית_links.json", JSON.stringify([rec(4, 3), rec(6, 999)]));

describe("links loaded before their books (F6)", () => {
  it("attach to the books when they open: the check finds them and knows the real length", async () => {
    const store = new AppStore(registryService(), { save: () => {} }, loadPreferences(null));
    await store.openFiles([LINKS]);
    expect(store.allLinks.value.every((l) => l.target.book.key.startsWith("unresolved:"))).toBe(true);
    await store.openFiles([file("books/בראשית.txt", BASE.join("\n")), file("books/ביאור קצר על בראשית.txt", COMM.join("\n"))]);
    const base = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    for (const l of store.allLinks.value) {
      expect(l.source.book.origin).toBe("otzaria");
      expect(l.target.book.key).toBe(base.key);
    }
    // the history holds the attached links too: undoing and redoing the import does not un-attach them
    store.undo();
    store.redo();
    expect(store.allLinks.value.every((l) => l.target.book.key === base.key)).toBe(true);

    const report = (await store.quality.run())!;
    const codes = report.issues.map((i) => i.problem.code);
    expect(codes).not.toContain("export/source-unknown");
    expect(codes).not.toContain("export/target-unknown");
    const out = report.issues.find((i) => i.problem.code === "export/line-out-of-range")!;
    expect(out.problem.message).toContain("בספר 12 שורות");
    expect(store.lines.count(base.key)).toBe(12);
  });

  it("a links file loaded first does not leave the target book phantom-long when its far line is read first", async () => {
    const store = new AppStore(registryService(), { save: () => {} }, loadPreferences(null));
    await store.openFiles([file("בראשית.txt", BASE.join("\n"))]);
    const key = [...store.books.value.keys()][0]!;
    await store.lines.load(key, 999, 999); // only the far chunk: an empty read past the end
    expect(store.lines.count(key)).toBe(12);
  });
});

describe("notices of links loaded before their books (F20)", () => {
  it("no 'book not found' per record while no book is open; once books open, only the still-missing ones", async () => {
    const store = new AppStore(registryService(), { save: () => {} }, loadPreferences(null));
    const withMissing = file("links/ביאור קצר על בראשית_links.json", JSON.stringify([rec(4, 3), { ...rec(6, 5), path_2: "ספר שלא קיים.txt", heRef_2: "ספר שלא קיים" }]));
    await store.openFiles([withMissing]);
    const first = store.notices.value.map((n) => [n.text, ...(n.details ?? [])].join(" ")).join("\n");
    expect(first).not.toContain("לא נמצא");
    expect(first).toContain("כשתפתחו אותם");
    await store.openFiles([file("books/בראשית.txt", BASE.join("\n")), file("books/ביאור קצר על בראשית.txt", COMM.join("\n"))]);
    const after = store.notices.value.filter((n) => n.text.includes("לא נמצא"));
    expect(after).toHaveLength(1);
    expect(after[0]!.text).toContain("ספר שלא קיים");
    expect(after[0]!.text).not.toContain("בראשית\"");
  });
});
