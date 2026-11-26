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

  it("wrong arguments exit with 2 and the usage", async () => {
    expect((await cli([])).code).toBe(2);
    expect((await cli(["--repo", ZMANENU])).code).toBe(2); // neither --out nor --dry-run
    const bad = await cli(["--repo", ZMANENU, "--dry-run", "--min-confidence", "none"]);
    expect([bad.code, bad.err]).toEqual([2, expect.stringMatching(/--min-confidence/)]);
    expect((await cli(["--help"])).out).toMatch(/שימוש/);
    expect((await cli(["--repo", "tests/fixtures/repos/nope", "--dry-run"])).code).toBe(1);
  });
});
