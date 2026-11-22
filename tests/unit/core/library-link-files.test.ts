import { describe, expect, it } from "vitest";
import { embeddedLibraryLinkFiles } from "../../../src/core/links/library-link-files";
import { LIBRARY_LINK_FILES_SNAPSHOT } from "../../../src/core/links/library-link-files-snapshot";

/*
 * The names of the <title>_links.json files in Otzaria/otzaria-library (scripts/library-link-files-snapshot.mjs,
 * a git ls-tree of the checkout at the commit recorded in the snapshot). Names only. Real facts it must hold:
 * the library has "ארצות החיים_links.json" (pninimToOtzaria/links); and "חברותא על ברכות_links.json" (ToratEmetToOtzaria/links),
 * which LINK_FORMATS §4.5 once recorded as missing — the library added it on 2026-10-17, after that measurement.
 */
describe("library link-file names", () => {
  const list = embeddedLibraryLinkFiles();
  it("decodes to the number of files the snapshot says, with its commit and date", () => {
    expect(list.titles.size).toBe(LIBRARY_LINK_FILES_SNAPSHOT.files);
    expect(list.titles.size).toBeGreaterThan(900);
    expect(LIBRARY_LINK_FILES_SNAPSHOT.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(list.label).toContain(LIBRARY_LINK_FILES_SNAPSHOT.date);
  });
  it("knows a library file and a book the library has no file for", () => {
    expect(list.titles.has("ארצות החיים")).toBe(true);
    expect(list.titles.has("חברותא על ברכות")).toBe(true);
    expect(list.titles.has("ספר שאין לו קובץ")).toBe(false);
  });
});
