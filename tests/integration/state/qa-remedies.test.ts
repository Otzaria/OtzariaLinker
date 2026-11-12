import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { qaAction } from "../../../src/linking/qa";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Product audit F8: "fix" from the quality check opened the builder, where nothing fixes a rule of the
 * library's sync, so the error stayed. The check now offers the remedy that does fix it, and applying
 * it removes the problem from the report.
 */
const BASE = ["<h1>בראשית</h1>", "<h2>פרק א</h2>", "בראשית ברא אלהים את השמים ואת הארץ.", "והארץ היתה תהו ובהו."];
const COMM = ["<h1>ביאור חדש על בראשית</h1>", "<h2>פרק א</h2>", "בראשית ברא - ביאור.", "תהו ובהו - ביאור."];
const txt = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });

async function opened() {
  const store = new AppStore(registryService(), { save: () => {} }, loadPreferences(null));
  await store.openFiles([txt("lib/בראשית.txt", BASE), txt("lib/ביאור חדש על בראשית.txt", COMM)]);
  const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
  store.setLibrarySource(key("בראשית").split(":")[0]!, true); // the library's own בראשית: Sefaria rules apply
  return { store, base: key("בראשית"), comm: key("ביאור חדש על בראשית") };
}
const codesOf = (r: { issues: { problem: { code: string; severity: string } }[] }, severity = "error") => r.issues.filter((i) => i.problem.severity === severity).map((i) => i.problem.code);

describe("the quality check offers a remedy that clears the problem (F8)", () => {
  it("an anchor the library refuses: 'remove the anchor' clears it", async () => {
    const { store } = await opened();
    // a sheet row from בראשית with a word anchor (start/end): the builder would not make it, a sheet can
    store.exchange.importLinksCsv("בראשית_links.csv", "line_index_1,heRef_2,path_2,line_index_2,Conection Type,start,end\n3,ביאור,ביאור חדש על בראשית.txt,3,commentary,0,6\n");
    expect(store.allLinks.value[0]!.anchor).toMatchObject({ rawStart: 0, rawEnd: 6 });
    let report = (await store.quality.run())!;
    const issue = report.issues.find((i) => i.problem.code === "sefaria/anchor-range")!;
    expect(qaAction(issue.problem, store.exportPurpose.value)).toBe("drop-anchor");
    store.dropAnchors([issue.link.id]);
    report = (await store.quality.run())!;
    expect(codesOf(report)).not.toContain("sefaria/anchor-range");
    expect(store.allLinks.value[0]!.anchor).toBeUndefined();
  });

  it("a missing English ref the tool cannot build: 'private use' clears the error", async () => {
    const { store, base, comm } = await opened();
    store.pickLine("source", comm, 2);
    store.pickLine("target", base, 2);
    expect(store.createFromDraft()).not.toBeNull();
    let report = (await store.quality.run())!;
    const issue = report.issues.find((i) => i.problem.code === "sefaria/ref2-required")!;
    expect(issue.problem.severity).toBe("error");
    expect(qaAction(issue.problem, store.exportPurpose.value)).toBe("private");
    store.exportPurpose.value = "private";
    report = (await store.quality.run())!;
    expect(codesOf(report)).toEqual([]);
    expect(qaAction({ ...issue.problem, severity: "warning" }, "private")).toBeNull();
  });
});
