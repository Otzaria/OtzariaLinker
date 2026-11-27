import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../../../src/cli/main";
import { REPORT_JSON, REPORT_TXT, type RunReport } from "../../../src/cli/run";
import { parseLinksJson } from "../../../src/formats/links-json/parse";

/*
 * The folder-repository runner (V7 §4.16, #46; docs/HEADLESS.md) end to end, in process — the same `main` the built
 * dist-cli/linker.mjs runs — on the two fixtures that mirror Otzaria/zmanenu-library and YairDaniel11/Otzarya-Unofficial-Books
 * (tests/fixtures/repos, scripts/fixtures/make-repo-fixtures.mjs) and the real slice of the official database. Every run checks
 * that the repository and the database are byte-for-byte as before, and that nothing was written outside --out.
 */
const DB = "tests/fixtures/db/seforim-v7-mini.db";
const ZMANENU = "tests/fixtures/repos/zmanenu";
const UNOFFICIAL = "tests/fixtures/repos/unofficial-books";
/** the pairs of the fixtures come out "high" (the max-link merge), and the default approves "certain" only */
const HIGH = ["--min-confidence", "high"];
const tmp: string[] = [];
const fresh = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `linker-${name}-`));
  tmp.push(d);
  return d;
};
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** every file under a folder: relative path → sha256 and mtime */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(dir, p).split(sep).join("/"), `${createHash("sha256").update(readFileSync(p)).digest("hex")}@${statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}
const tree = (dir: string) => [...snapshot(dir).keys()].sort();

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(args, { out: (t) => void (out += t), err: (t) => void (err += t) });
  return { code, out, err };
}

/** runs the CLI with the repository and the database watched: neither may change */
async function untouched(repo: string, args: string[]) {
  const before = { repo: snapshot(repo), db: snapshot("tests/fixtures/db") };
  const r = await cli(args);
  expect(snapshot(repo)).toEqual(before.repo);
  expect(snapshot("tests/fixtures/db")).toEqual(before.db);
  return r;
}

describe("the runner on a repository shaped like Otzarya-Unofficial-Books", { timeout: 60_000 }, () => {
  it("dry run: only the report is written; it names the files in the repository's places, an existing one as an update", async () => {
    const out = fresh("dry");
    const r = await untouched(UNOFFICIAL, ["--repo", UNOFFICIAL, "--db", DB, "--out", out, "--dry-run", ...HIGH]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(tree(out)).toEqual([REPORT_JSON, REPORT_TXT].sort());
    const rep = JSON.parse(readFileSync(join(out, REPORT_JSON), "utf8")) as RunReport;
    expect(rep).toMatchObject({ layout: "unofficial-books", dryRun: true, books: { total: 4, selected: 4 } });
    expect(rep.skippedFiles.map((s) => s.path)).toEqual(expect.arrayContaining(["ספרים/סדר.txt", "ספרים/משנה/סדר.txt"]));
    const files = new Map(rep.files.map((f) => [f.path, f]));
    // dibur-hamatchil writes from the base (with the anchor on the quoted words): the base's file, in links/ beside it
    expect(files.get("ספרים/משנה/links/ספר בסיס לדוגמה_links.json")).toMatchObject({ action: "new", kind: "links-json" });
    // the existing file of "ביאור ישן" would be written back exactly as it is: not a change, not written
    expect(files.has("ספרים/משנה/מפרשים/links/ביאור ישן על ספר בסיס לדוגמה_links.json")).toBe(false);
    expect(rep.unchanged).toEqual(["ספרים/משנה/מפרשים/links/ביאור ישן על ספר בסיס לדוגמה_links.json"]);
    // links to the official library: links.csv in the NEXT numbered folder (01 is the repository's)
    expect(files.get("ספרים/קבצי קישורים וסדר הדורות/קישורים/02/links.csv")).toMatchObject({ action: "new", kind: "links-csv" });
    expect(rep.links.internal).toBeGreaterThan(0);
    expect(rep.links.external).toBeGreaterThan(0);
    expect(r.out).toMatch(/הרצה יבשה/);
    expect(readFileSync(join(out, REPORT_TXT), "utf8")).toMatch(/המאגר לא שונה/);
  });

  it("a run writes the same files under --out, nothing else; a link the repository already has is not written again", async () => {
    const out = fresh("run");
    const r = await untouched(UNOFFICIAL, ["--repo", UNOFFICIAL, "--db", DB, "--out", out, ...HIGH]);
    expect(r.code).toBe(0);
    const rep = JSON.parse(readFileSync(join(out, REPORT_JSON), "utf8")) as RunReport;
    expect(tree(out)).toEqual([REPORT_JSON, REPORT_TXT, ...rep.files.map((f) => f.path)].sort());
    const base = parseLinksJson(readFileSync(join(out, "ספרים/משנה/links/ספר בסיס לדוגמה_links.json"), "utf8"));
    expect(base.issues.filter((i) => i.level === "error")).toEqual([]);
    // 30 lines of each commentary, less the one pair "ביאור ישן" line 3 ↔ base line 3 that its own file already holds
    expect(base.records).toHaveLength(59);
    const pairs = base.records.map((x) => `${x.line_index_1}>${x.path_2}:${x.line_index_2}`);
    expect(pairs).not.toContain("3>ביאור ישן על ספר בסיס לדוגמה.txt:3");
    expect(new Set(pairs).size).toBe(pairs.length);
    const csv = readFileSync(join(out, "ספרים/קבצי קישורים וסדר הדורות/קישורים/02/links.csv"), "utf8");
    expect(csv.startsWith("﻿מקור,ספר_מקור,מקור_אישי,ספר_יעד,מיקום_יעד,סוג,יעד_אישי,קטגוריית_מקור\r\n")).toBe(true);
    expect(csv).toMatch(/ביאור חדש על בראשית,כן,בראשית,/);
  });

  // found on the real clone of Otzarya-Unofficial-Books (V7 round 2, item 8): links.csv was prepared from EVERY link of the project,
  // so the report said "not written: 7,086 — both sides in the same repository" for the links of the existing files and the new
  // internal ones (here 60), and an existing record whose path_2 names an official book would have been written into links.csv again
  it("links.csv holds the run's links to the official library only; the repository's own links are not 'not written' there", async () => {
    const rep = JSON.parse((await cli(["--repo", UNOFFICIAL, "--db", DB, "--dry-run", "--json", ...HIGH])).out) as RunReport;
    expect(rep.links.external).toBe(10);
    expect(rep.external.written).toBe(10);
    expect(rep.external.skipped).toEqual([]);
  });

  // found on the real clone of Otzarya-Unofficial-Books (V7 round 2, item 8): 8 books have a file name the title rules change (two
  // spaces: "אמרי נועם  על הגדה של פסח"), and the build takes a book's title from its file name AS IS (build_personal_db.py) — so a
  // links.csv row under the normalized title is silently dropped there, and the book's links file (named like the file) did not
  // belong to the normalized title the run gives the book.
  it("a book whose file name has two spaces: its links file is found and kept, and links.csv names the book as its file does", async () => {
    const root = fresh("spaces");
    const repo = join(root, "unofficial-books");
    cpSync(UNOFFICIAL, repo, { recursive: true });
    const dir = join(repo, "ספרים/משנה/מפרשים");
    const odd = "ביאור  ישן על ספר בסיס לדוגמה";
    writeFileSync(join(dir, `${odd}.txt`), readFileSync(join(dir, "ביאור ישן על ספר בסיס לדוגמה.txt")));
    rmSync(join(dir, "ביאור ישן על ספר בסיס לדוגמה.txt"));
    writeFileSync(join(dir, "links", `${odd}_links.json`), readFileSync(join(dir, "links/ביאור ישן על ספר בסיס לדוגמה_links.json")));
    rmSync(join(dir, "links/ביאור ישן על ספר בסיס לדוגמה_links.json"));
    const tanakh = join(repo, "ספרים/תנ״ך/מפרשים");
    writeFileSync(join(tanakh, "ביאור  חדש על בראשית.txt"), readFileSync(join(tanakh, "ביאור חדש על בראשית.txt")));
    rmSync(join(tanakh, "ביאור חדש על בראשית.txt"));

    const out = fresh("spaces-out");
    const r = await untouched(repo, ["--repo", repo, "--db", DB, "--out", out, ...HIGH]);
    expect(r.code).toBe(0);
    const rep = JSON.parse(readFileSync(join(out, REPORT_JSON), "utf8")) as RunReport;
    // no second links file under the normalized title
    expect(rep.files.map((f) => f.path).filter((p) => p.includes("ביאור ישן"))).toEqual([]);
    // the base's new file: the existing pair is still known (3 ↔ 3 not written again)
    const base = parseLinksJson(readFileSync(join(out, "ספרים/משנה/links/ספר בסיס לדוגמה_links.json"), "utf8"));
    expect(base.records).toHaveLength(59);
    // links.csv names the book as its file does
    const csv = readFileSync(join(out, "ספרים/קבצי קישורים וסדר הדורות/קישורים/02/links.csv"), "utf8");
    expect(csv).toMatch(/,ביאור {2}חדש על בראשית,כן,בראשית,/);
    expect(csv).not.toMatch(/,ביאור חדש על בראשית,/);
  });

  // V7 round 2, items 8-9 on Otzarya-Unofficial-Books: the repository's links.csv files (17 folders, ~25 MB of rows) are imported into
  // the personal database, not into seforim.db, so neither the suggestions' "already exists" nor the export knew them — a run wrote
  // their rows again into the next folder. A row they already have (the same line, book, target and place; any type) is not written.
  it("a links.csv row the repository already has is not written again into the new folder", async () => {
    const root = fresh("csv-dup");
    const repo = join(root, "unofficial-books");
    cpSync(UNOFFICIAL, repo, { recursive: true });
    const csv01 = join(repo, "ספרים/קבצי קישורים וסדר הדורות/קישורים/01/links.csv");
    writeFileSync(csv01, `${readFileSync(csv01, "utf8")}4,ביאור חדש על בראשית,כן,בראשית,פרק א,תרגום,לא,\r\n`);
    const r = await untouched(repo, ["--repo", repo, "--db", DB, "--dry-run", "--json", ...HIGH]);
    const rep = JSON.parse(r.out) as RunReport;
    expect(rep.links.external).toBe(10);
    expect(rep.external.written).toBe(9);
    expect(rep.alreadyInRepository).toBe(1);
    const out = fresh("csv-dup-out");
    await untouched(repo, ["--repo", repo, "--db", DB, "--out", out, ...HIGH]);
    const text = readFileSync(join(out, "ספרים/קבצי קישורים וסדר הדורות/קישורים/02/links.csv"), "utf8");
    expect(text.split("\r\n").filter((l) => l.startsWith("4,ביאור חדש על בראשית,"))).toEqual([]);
    expect(text.split("\r\n").filter((l) => /^\d+,ביאור חדש על בראשית,/.test(l))).toHaveLength(9);
  });

  // V7 round 2 review, finding 11: an existing links.csv whose header is not this tool's exact one gave no rows (parsePersonalLinksCsv
  // trusts only its own header), so its rows were written again with no word. The build reads the files by column name: another
  // order of the columns, or without קטגוריית_מקור, is the same file to it, and its rows are read; a file the build cannot read
  // (a column a row's identity needs is missing) stops the run with the file and the columns, so nothing is written on a guess.
  it("an existing links.csv with its columns in another order is read: its rows are not written again", async () => {
    const root = fresh("csv-order");
    const repo = join(root, "unofficial-books");
    cpSync(UNOFFICIAL, repo, { recursive: true });
    const csv01 = join(repo, "ספרים/קבצי קישורים וסדר הדורות/קישורים/01/links.csv");
    writeFileSync(csv01, "﻿ספר_מקור,מקור,ספר_יעד,מיקום_יעד,סוג,מקור_אישי,יעד_אישי\r\nספר ישן,3,בראשית,פרק א,פירוש,כן,לא\r\nביאור חדש על בראשית,4,בראשית,פרק א,תרגום,כן,לא\r\n");
    const r = await untouched(repo, ["--repo", repo, "--db", DB, "--dry-run", "--json", ...HIGH]);
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.out) as RunReport;
    expect(rep.links.external).toBe(10);
    expect(rep.external.written).toBe(9);
    expect(rep.alreadyInRepository).toBe(1);
  });

  it("an existing links.csv the build cannot read (a column is missing): the run stops, names the file and the columns, writes nothing", async () => {
    const root = fresh("csv-unknown");
    const repo = join(root, "unofficial-books");
    cpSync(UNOFFICIAL, repo, { recursive: true });
    const csv01 = join(repo, "ספרים/קבצי קישורים וסדר הדורות/קישורים/01/links.csv");
    writeFileSync(csv01, "﻿שורה,ספר,יעד,מיקום_יעד,סוג\r\n4,ביאור חדש על בראשית,בראשית,פרק א,תרגום\r\n");
    const out = join(fresh("csv-unknown-out"), "out");
    const r = await untouched(repo, ["--repo", repo, "--db", DB, "--out", out, ...HIGH]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("ספרים/קבצי קישורים וסדר הדורות/קישורים/01/links.csv");
    expect(r.err).toMatch(/מקור, ספר_מקור, ספר_יעד/);
    expect(existsSync(out)).toBe(false);
  });

  // found on the real clone of Otzarya-Unofficial-Books (V7 round 2, item 8): its links files of "X על אבות" link to the official
  // "משנה אבות" by path_2. The runner loaded the repository's files before it opened the database, so every such record was reported
  // "the book was not found by its exact name; Otzaria will skip such a link" — 14 notices, 6,014 lines, all wrong.
  it("an existing record that links to an official book is read with the database open: no 'book not found' for it", async () => {
    const root = fresh("official-path2");
    const repo = join(root, "unofficial-books");
    cpSync(UNOFFICIAL, repo, { recursive: true });
    const file = join(repo, "ספרים/תנ״ך/מפרשים/links/ביאור חדש על בראשית_links.json");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify([{ line_index_1: 4, line_index_2: 3, heRef_2: "בראשית, א, א", path_2: "בראשית.txt", "Conection Type": "source" }], null, 2));
    const r = await untouched(repo, ["--repo", repo, "--db", DB, "--dry-run", "--json", ...HIGH]);
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.out) as RunReport;
    expect(rep.notices.flatMap((n) => [n.text, ...(n.details ?? [])]).filter((t) => /לא נמצא בשם מדויק/.test(t))).toEqual([]);
  });

  // found on the real clone of Otzarya-Unofficial-Books (V7 round 2, item 8): git on Windows with core.autocrlf=true checks the
  // files out with CRLF (the index holds LF). The export writes LF, so every existing links file of the books run came out as an
  // "update" with the same records — 21 files in "בית שני" whose only difference was the line endings, which git does not even see.
  it("an existing file that differs only by the checkout's CRLF line endings is unchanged, not an update", async () => {
    const root = fresh("crlf");
    const repo = join(root, "unofficial-books");
    cpSync(UNOFFICIAL, repo, { recursive: true });
    const old = join(repo, "ספרים/משנה/מפרשים/links/ביאור ישן על ספר בסיס לדוגמה_links.json");
    writeFileSync(old, readFileSync(old, "utf8").replace(/\n/g, "\r\n"));
    const r = await untouched(repo, ["--repo", repo, "--db", DB, "--dry-run", "--json", ...HIGH]);
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.out) as RunReport;
    expect(rep.files.map((f) => f.path)).not.toContain("ספרים/משנה/מפרשים/links/ביאור ישן על ספר בסיס לדוגמה_links.json");
    expect(rep.unchanged).toEqual(["ספרים/משנה/מפרשים/links/ביאור ישן על ספר בסיס לדוגמה_links.json"]);
  });

  it("the same from a ZIP of the repository (GitHub's one top folder), offline", async () => {
    const zipDir = fresh("zip");
    const entries: Record<string, Uint8Array> = {};
    for (const p of tree(UNOFFICIAL)) entries[`Otzarya-Unofficial-Books-main/${p}`] = new Uint8Array(readFileSync(join(UNOFFICIAL, p)));
    entries["Otzarya-Unofficial-Books-main/.github/x.txt"] = strToU8("not a book");
    const zip = join(zipDir, "repo.zip");
    writeFileSync(zip, zipSync(entries));
    const dry = await cli(["--repo", zip, "--db", DB, "--dry-run", "--json", ...HIGH]);
    expect(dry.code).toBe(0);
    const rep = JSON.parse(dry.out) as RunReport;
    const fromFolder = JSON.parse((await cli(["--repo", UNOFFICIAL, "--db", DB, "--dry-run", "--json", ...HIGH])).out) as RunReport;
    expect(rep.files).toEqual(fromFolder.files);
    expect(rep.books).toEqual(fromFolder.books);
  });

  it("filters: --include narrows the books, and without --db only the repository's own links are made", async () => {
    const r = await cli(["--repo", UNOFFICIAL, "--include", "ספרים/משנה/**", "--dry-run", "--json", ...HIGH]);
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.out) as RunReport;
    expect(rep.books.selected).toBe(3);
    expect(rep.links.external).toBe(0);
    expect(rep.files.every((f) => f.kind === "links-json")).toBe(true);
  });
});

describe("the runner on a repository shaped like zmanenu-library", { timeout: 60_000 }, () => {
  it("writes the internal links and the links to the official library (target_library) into source/links; a file in the zmanenu format is appended to, never rewritten", async () => {
    const out = fresh("zm");
    const r = await untouched(ZMANENU, ["--repo", ZMANENU, "--db", DB, "--out", out, ...HIGH]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const rep = JSON.parse(readFileSync(join(out, REPORT_JSON), "utf8")) as RunReport;
    expect(rep.layout).toBe("zmanenu");
    expect(rep.books.titles).not.toContain("מהדורה מנוקדת");
    expect(rep.appendedOnly).toEqual(["source/links/ביאור לדוגמה על בראשית_links.json"]);
    expect(tree(out)).toEqual([REPORT_JSON, REPORT_TXT, ...rep.files.map((f) => f.path)].sort());
    expect(rep.files.map((f) => [f.path, f.action])).toEqual([
      ["source/links/ביאור לדוגמה על בראשית_links.json", "update"],
      ["source/links/ספר לדוגמה_links.json", "new"],
    ]);

    // the zmanenu-format file: its own text first, exactly, then the new target_library records with the official heRef
    const old = readFileSync(join(ZMANENU, "source/links/ביאור לדוגמה על בראשית_links.json"), "utf8");
    const now = readFileSync(join(out, "source/links/ביאור לדוגמה על בראשית_links.json"), "utf8");
    expect(now.startsWith(old.slice(0, old.lastIndexOf("}") + 1))).toBe(true);
    const all = JSON.parse(now) as Record<string, unknown>[];
    expect(all.slice(0, 2)).toEqual(JSON.parse(old));
    const added = all.slice(2);
    expect(added).toHaveLength(9); // ten verses; the record of verse 1 was already there
    expect(added.every((x) => x.target_library === "official" && x.book_2 === "בראשית" && x["Conection Type"] === "source" && /^בראשית, א, /.test(String(x.heRef_2)))).toBe(true);
    expect(rep.external.written).toBe(9);

    // the internal pair, from the base, in the one links folder
    const internal = parseLinksJson(readFileSync(join(out, "source/links/ספר לדוגמה_links.json"), "utf8"));
    expect(internal.records).toHaveLength(30);
    expect(internal.records.every((x) => x.path_2 === "ביאור על ספר לדוגמה.txt")).toBe(true);
    expect(rep.external).toMatchObject({ mode: "target-library" });
  });

  // V7 round 2, item 9: a file in the zmanenu format is kept aside (not loaded into the project), so the links its book_2 records
  // already say were made again — written in the other book's file (a reverse duplicate), or as a path_2 record beside a book_2 one,
  // or as a target_library record with heRef_2 beside one that says the same official line by line_index_2.
  it("a link the repository's book_2 / target_library records already say is not written again, in any direction or form", async () => {
    const root = fresh("zm-dup");
    const repo = join(root, "zmanenu");
    cpSync(ZMANENU, repo, { recursive: true });
    // the commentary's own file, in the zmanenu format: base line 3 ↔ commentary line 3 by book_2 (the run writes that pair from
    // the base, the other way), line 4 ↔ 4 by path_2 (no different from a loaded file, but this file is never loaded)
    writeFileSync(
      join(repo, "source/links/ביאור על ספר לדוגמה_links.json"),
      `${JSON.stringify(
        [
          { line_index_1: 3, line_index_2: 3, book_2: "ספר לדוגמה", "Conection Type": "source" },
          { line_index_1: 4, line_index_2: 4, path_2: "ספר לדוגמה.txt", "Conection Type": "reference" },
        ],
        null,
        2,
      )}\n`,
    );
    // verse 2 (commentary line 6) by the official line (1-based 4 = בראשית, א, ב), not by heRef
    const berFile = join(repo, "source/links/ביאור לדוגמה על בראשית_links.json");
    const ber = JSON.parse(readFileSync(berFile, "utf8")) as unknown[];
    writeFileSync(berFile, `${JSON.stringify([...ber, { line_index_1: 6, target_library: "official", book_2: "בראשית", line_index_2: 4, "Conection Type": "source" }], null, 2)}\n`);

    const out = fresh("zm-dup-out");
    const r = await untouched(repo, ["--repo", repo, "--db", DB, "--out", out, ...HIGH]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const rep = JSON.parse(readFileSync(join(out, REPORT_JSON), "utf8")) as RunReport;
    expect(rep.appendedOnly.sort()).toEqual(["source/links/ביאור לדוגמה על בראשית_links.json", "source/links/ביאור על ספר לדוגמה_links.json"]);

    const base = parseLinksJson(readFileSync(join(out, "source/links/ספר לדוגמה_links.json"), "utf8"));
    const pairs = base.records.map((x) => `${x.line_index_1}:${x.line_index_2}`);
    expect(pairs).not.toContain("3:3");
    expect(pairs).not.toContain("4:4");
    expect(base.records).toHaveLength(28);

    const added = (JSON.parse(readFileSync(berFile.replace(repo, out), "utf8")) as Record<string, unknown>[]).slice(3);
    expect(added.map((x) => x.line_index_1)).not.toContain(6);
    expect(added).toHaveLength(8);
    expect(rep.external.written).toBe(8);
    // the two internal pairs, verse 2 by line, and verse 1 by heRef (the fixture's own record, which appendRecords also kept out)
    expect(rep.alreadyInRepository).toBe(4);
    expect(readFileSync(join(out, REPORT_TXT), "utf8")).toMatch(/כבר כתובים ברשומות של המאגר: 4/);
  });

  // V7 round 2 review, finding 11: the run names a book by the title rules (otzariaBookTitle: "ספר  לדוגמה", two spaces, is "ספר
  // לדוגמה"), and a kept-aside record names it as its FILE does. recordedLinks compared book_2 / path_2 as written, so the pair was
  // not known and the run wrote it again in the other book's file.
  it("a book_2 / path_2 record that names a book as its file does (two spaces) is known: the pair is not written again", async () => {
    const root = fresh("zm-spaces");
    const repo = join(root, "zmanenu");
    cpSync(ZMANENU, repo, { recursive: true });
    const books = join(repo, "source/books/הלכה");
    writeFileSync(join(books, "ספר  לדוגמה.txt"), readFileSync(join(books, "ספר לדוגמה.txt")));
    rmSync(join(books, "ספר לדוגמה.txt"));
    writeFileSync(
      join(repo, "source/links/ביאור על ספר לדוגמה_links.json"),
      `${JSON.stringify(
        [
          { line_index_1: 3, line_index_2: 3, book_2: "ספר  לדוגמה", "Conection Type": "source" },
          { line_index_1: 4, line_index_2: 4, path_2: "ספר  לדוגמה.txt", "Conection Type": "reference" },
        ],
        null,
        2,
      )}\n`,
    );
    const out = fresh("zm-spaces-out");
    const r = await untouched(repo, ["--repo", repo, "--db", DB, "--out", out, ...HIGH]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const rep = JSON.parse(readFileSync(join(out, REPORT_JSON), "utf8")) as RunReport;
    expect(rep.books.titles).toContain("ספר לדוגמה");
    const base = parseLinksJson(readFileSync(join(out, "source/links/ספר לדוגמה_links.json"), "utf8"));
    const pairs = base.records.map((x) => `${x.line_index_1}:${x.line_index_2}`);
    expect(pairs).not.toContain("3:3");
    expect(pairs).not.toContain("4:4");
    expect(base.records).toHaveLength(28);
  });
});

describe("the runner refuses what would overwrite or write into the repository", { timeout: 60_000 }, () => {
  it("--out inside the repository, a non-empty --out, a second run into the same --out: refused, nothing written", async () => {
    const inside = await untouched(ZMANENU, ["--repo", ZMANENU, "--out", join(ZMANENU, "out"), "--dry-run"]);
    expect(inside.code).toBe(1);
    expect(inside.err).toMatch(/בתוך המאגר|המאגר עצמו/);

    const busy = fresh("busy");
    writeFileSync(join(busy, "keep.txt"), "mine");
    const r = await cli(["--repo", ZMANENU, "--out", busy]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/אינה ריקה/);
    expect(tree(busy)).toEqual(["keep.txt"]);
    expect(readFileSync(join(busy, "keep.txt"), "utf8")).toBe("mine");
  });

  // V7 PR4 review, finding 2: the check compared path.resolve strings, so a case variant of the repository's path (on a
  // case-insensitive file system) or a junction/symlink into it passed, and the run wrote into the repository.
  const copyRepo = () => {
    const root = fresh("case");
    const repo = join(root, "Repo");
    cpSync(ZMANENU, repo, { recursive: true });
    return { root, repo };
  };
  const caseInsensitive = (() => {
    const d = fresh("probe");
    mkdirSync(join(d, "Probe"));
    return existsSync(join(d, "probe"));
  })();

  it.runIf(caseInsensitive)("--out in a case variant of the repository's path: refused, nothing written", async () => {
    const { root, repo } = copyRepo();
    const r = await untouched(repo, ["--repo", repo, "--out", join(root, "repo", "linker-out")]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/בתוך המאגר|המאגר עצמו/);
  });

  it("--out through a junction or symlink into the repository: refused, nothing written", async () => {
    const { root, repo } = copyRepo();
    const link = join(root, "link");
    symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
    for (const out of [join(link, "linker-out"), link]) {
      const r = await untouched(repo, ["--repo", repo, "--out", out]);
      expect(r.code, out).toBe(1);
      expect(r.err).toMatch(/בתוך המאגר|המאגר עצמו/);
    }
  });

  it("--out that holds the repository: refused as such, not only as a non-empty folder", async () => {
    const { root, repo } = copyRepo();
    const r = await untouched(repo, ["--repo", repo, "--out", root]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/המאגר נמצא בתוכה/);
  });

  // found on the real clone of zmanenu-library (V7 round 2, item 8): the report said "one file was not opened" and not which or why —
  // the notice's details (the file and the reason) were dropped
  it("a notice's details reach the report: which file was not opened, and why", async () => {
    const dir = fresh("notdb");
    const bad = join(dir, "seforim.db");
    writeFileSync(bad, "not a database at all");
    const r = await cli(["--repo", ZMANENU, "--db", bad, "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.out) as RunReport;
    const n = rep.notices.find((x) => /לא נפתח/.test(x.text));
    expect(n?.details?.join(" ")).toMatch(/seforim\.db/);
    const text = await cli(["--repo", ZMANENU, "--db", bad, "--dry-run"]);
    expect(text.out).toMatch(/seforim\.db: /);
  });

  // V7 round 2 review, finding 6: a --db that exists but is a folder was opened as nothing, and the run went on with no database
  // while the report said "מסד אוצריא: <the folder>" — every link to the official library was dropped with no word, and exit 0.
  it("--db that is a folder, not a file: refused as wrong arguments, nothing run or written", async () => {
    const out = join(fresh("db-folder"), "out");
    const r = await untouched(ZMANENU, ["--repo", ZMANENU, "--db", "tests/fixtures/db", "--out", out]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/tests[\\/]fixtures[\\/]db/);
    expect(r.err).toMatch(/תיקייה/);
    expect(existsSync(out)).toBe(false);
    const dry = await cli(["--repo", ZMANENU, "--db", "tests/fixtures/db", "--dry-run", "--json"]);
    expect([dry.code, dry.out]).toEqual([2, ""]);
  });

  it("wrong arguments exit with 2 and the usage", async () => {
    expect((await cli([])).code).toBe(2);
    expect((await cli(["--repo", ZMANENU])).code).toBe(2); // neither --out nor --dry-run
    const bad = await cli(["--repo", ZMANENU, "--dry-run", "--min-confidence", "none"]);
    expect([bad.code, bad.err]).toEqual([2, expect.stringMatching(/--min-confidence/)]);
    expect((await cli(["--help"])).out).toMatch(/שימוש/);
    expect((await cli(["--repo", "tests/fixtures/repos/nope", "--dry-run"])).code).toBe(1);
  });
});
