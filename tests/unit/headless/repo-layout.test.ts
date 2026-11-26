import { describe, expect, it } from "vitest";
import { detectRepoLayout, filterBooks, nextCsvFolders } from "../../../src/headless/repo-layout";

/*
 * Folder-based book repositories (V7 §4.16, #46): which kind a tree is, which files are its books and links files, and where a
 * book's links file goes. The trees are the structures read from the public GitHub API on 2026-11-26 (read only, nothing cloned):
 *   Otzaria/zmanenu-library           library.json; source/books/<category>/<title>.txt; ONE folder source/links/<title>_links.json;
 *                                     source/editions/<title>/*.txt are editions of a book, not books; links to the official
 *                                     library are records with target_library (docs/format.md)
 *   YairDaniel11/Otzarya-Unofficial-Books  ספרים/<category…>/<title>.txt; a links/ folder BESIDE the books it serves (281 of 322
 *                                     files; 18 in the book's own folder, 23 elsewhere); סדר.txt orders a folder and is not a book;
 *                                     links to the official library are links.csv files in numbered folders under
 *                                     "ספרים/קבצי קישורים וסדר הדורות/קישורים/NN" (and "קישורים - קבצי קובץ (גדולים)/NN")
 */
const ZMANENU = [
  "library.json",
  "README.md",
  "builder/test/fixtures/examples/books/הלכה/שבת/קיצור הלכות שבת לדוגמה.txt",
  "source/categories.json",
  "source/metadata.json",
  "source/books/דברי פתיחה.txt",
  "source/books/הלכה/ספר לדוגמה.txt",
  "source/books/הלכה/ביאור על ספר לדוגמה.txt",
  "source/books/תנ״ך/ביאור לדוגמה על בראשית.txt",
  "source/editions/ספר לדוגמה/מהדורה מנוקדת.txt",
  "source/links/ביאור על ספר לדוגמה_links.json",
  "source/alt_toc/ספר לדוגמה_alt_toc.json",
];
const UNOFFICIAL = [
  "README.md",
  "manifest.json",
  "רשימת ספרים שיש במאגר כרגע",
  ".github/workflows/build-db.yml",
  ".claude/skills/x/SKILL.md",
  "ספרים/סדר.txt",
  "ספרים/משנה/סדר.txt",
  "ספרים/משנה/ספר בסיס לדוגמה.txt",
  "ספרים/משנה/מפרשים/פירוש על ספר בסיס לדוגמה.txt",
  "ספרים/משנה/מפרשים/ביאור ישן על ספר בסיס לדוגמה.txt",
  "ספרים/משנה/מפרשים/links/ביאור ישן על ספר בסיס לדוגמה_links.json",
  "ספרים/תנ״ך/מפרשים/ביאור חדש על בראשית.txt",
  "ספרים/תנ״ך/מפרשים/ספר.pdf",
  "ספרים/קבצי קישורים וסדר הדורות/דורות.csv",
  "ספרים/קבצי קישורים וסדר הדורות/קישורים/01/links.csv",
  "ספרים/קבצי קישורים וסדר הדורות/קישורים/02/links.csv",
];

describe("detectRepoLayout", () => {
  it("zmanenu: books under source/books only, editions and builder fixtures are not books, one links folder", () => {
    const l = detectRepoLayout(ZMANENU);
    expect(l.kind).toBe("zmanenu");
    expect(l.booksRoot).toBe("source/books");
    expect(l.books.map((b) => b.title).sort()).toEqual(["ביאור לדוגמה על בראשית", "ביאור על ספר לדוגמה", "דברי פתיחה", "ספר לדוגמה"]);
    expect(l.linksFiles).toEqual([{ path: "source/links/ביאור על ספר לדוגמה_links.json", title: "ביאור על ספר לדוגמה" }]);
    expect(l.skipped).toContainEqual({ path: "source/editions/ספר לדוגמה/מהדורה מנוקדת.txt", reason: expect.stringMatching(/מהדורה/) });
    expect(l.external).toBe("target-library");
    // an existing file is that file; a new one goes to the one links folder
    expect(l.linksFileFor("ביאור על ספר לדוגמה")).toEqual({ path: "source/links/ביאור על ספר לדוגמה_links.json", exists: true });
    expect(l.linksFileFor("ספר לדוגמה")).toEqual({ path: "source/links/ספר לדוגמה_links.json", exists: false });
  });

  it("unofficial-books: books under ספרים, סדר.txt and non-text files are not books, a new links file goes to links/ beside the book", () => {
    const l = detectRepoLayout(UNOFFICIAL);
    expect(l.kind).toBe("unofficial-books");
    expect(l.booksRoot).toBe("ספרים");
    expect(l.books.map((b) => b.path)).toEqual([
      "ספרים/משנה/מפרשים/ביאור ישן על ספר בסיס לדוגמה.txt",
      "ספרים/משנה/מפרשים/פירוש על ספר בסיס לדוגמה.txt",
      "ספרים/משנה/ספר בסיס לדוגמה.txt",
      "ספרים/תנ״ך/מפרשים/ביאור חדש על בראשית.txt",
    ]);
    expect(l.skipped.map((s) => s.path)).toEqual(expect.arrayContaining(["ספרים/סדר.txt", "ספרים/משנה/סדר.txt"]));
    expect(l.external).toBe("links-csv");
    expect(l.linksFileFor("פירוש על ספר בסיס לדוגמה")).toEqual({ path: "ספרים/משנה/מפרשים/links/פירוש על ספר בסיס לדוגמה_links.json", exists: false });
    expect(l.linksFileFor("ביאור ישן על ספר בסיס לדוגמה")).toEqual({ path: "ספרים/משנה/מפרשים/links/ביאור ישן על ספר בסיס לדוגמה_links.json", exists: true });
    expect(l.csvRoot).toBe("ספרים/קבצי קישורים וסדר הדורות");
    expect(l.csvFolders).toEqual(["קישורים/01", "קישורים/02"]);
  });

  it("a plain folder: every .txt outside hidden folders is a book; with a top links/ folder the files go there, otherwise beside the book", () => {
    const flat = detectRepoLayout(["א.txt", "sub/ב על א.txt", ".git/x.txt", "node_modules/y.txt"]);
    expect(flat.kind).toBe("folder");
    expect(flat.books.map((b) => b.path)).toEqual(["sub/ב על א.txt", "א.txt"]);
    expect(flat.linksFileFor("ב על א")).toEqual({ path: "sub/links/ב על א_links.json", exists: false });
    expect(flat.external).toBe("links-json");
    const central = detectRepoLayout(["א.txt", "ב על א.txt", "links/ג_links.json"]);
    expect(central.linksFileFor("ב על א")).toEqual({ path: "links/ב על א_links.json", exists: false });
  });

  it("two files that make the same title: both reported, neither guessed, and no links file is placed for that title", () => {
    const l = detectRepoLayout(["ספרים/א/ספר.txt", "ספרים/ב/ספר.txt", "ספרים/ג/אחר.txt"]);
    expect(l.duplicateTitles).toEqual([{ title: "ספר", paths: ["ספרים/א/ספר.txt", "ספרים/ב/ספר.txt"] }]);
    expect(l.books.map((b) => b.title)).toEqual(["אחר"]);
  });

  // found on the real clone of Otzaria/zmanenu-library (V7 round 2, item 8): its builder's test fixtures hold links files
  // (builder/test/fixtures/examples/links/*_links.json). The builder reads source/links only, so those are not the repository's
  // links files — but they were counted, and a book of source/books with the same title would have had its links "update" the
  // builder's fixture instead of source/links.
  it("zmanenu: only source/links holds the repository's links files; a links file elsewhere (the builder's fixtures) is not one", () => {
    const fixtures = ["builder/test/fixtures/examples/links/ספר לדוגמה_links.json", "builder/test/fixtures/examples/links/ביאור על ספר לדוגמה_links.json"];
    const l = detectRepoLayout([...ZMANENU, ...fixtures]);
    expect(l.linksFiles).toEqual([{ path: "source/links/ביאור על ספר לדוגמה_links.json", title: "ביאור על ספר לדוגמה" }]);
    expect(l.linksFileFor("ספר לדוגמה")).toEqual({ path: "source/links/ספר לדוגמה_links.json", exists: false });
    expect(l.linksFileFor("ביאור על ספר לדוגמה")).toEqual({ path: "source/links/ביאור על ספר לדוגמה_links.json", exists: true });
  });

  it("a links file whose name is not a book of the tree is still listed (it may serve the official library)", () => {
    const l = detectRepoLayout([...ZMANENU, "source/links/בראשית_links.json"]);
    expect(l.linksFiles.map((f) => f.title)).toContain("בראשית");
  });

  it("refuses an unsafe path in the listing", () => {
    expect(() => detectRepoLayout(["../x.txt"])).toThrow(/נתיב/);
  });
});

describe("filterBooks", () => {
  const { books } = detectRepoLayout(UNOFFICIAL);
  it("include and exclude by path glob or by words of the title; a limit takes the first in path order", () => {
    expect(filterBooks(books, { include: ["ספרים/משנה/**"] }).map((b) => b.title)).toEqual(["ביאור ישן על ספר בסיס לדוגמה", "פירוש על ספר בסיס לדוגמה", "ספר בסיס לדוגמה"]);
    expect(filterBooks(books, { exclude: ["*ישן*"] }).map((b) => b.title)).not.toContain("ביאור ישן על ספר בסיס לדוגמה");
    expect(filterBooks(books, { include: ["בראשית"] }).map((b) => b.title)).toEqual(["ביאור חדש על בראשית"]);
    expect(filterBooks(books, { limit: 2 })).toHaveLength(2);
  });
});

describe("nextCsvFolders", () => {
  it("numbers new links.csv folders after the existing ones, in each root", () => {
    expect(nextCsvFolders(["קישורים/01", "קישורים/02"], ["קישורים/01", "קישורים/02", "קישורים - קבצי קובץ (גדולים)/01"])).toEqual(["קישורים/03", "קישורים/04", "קישורים - קבצי קובץ (גדולים)/01"]);
  });
});
