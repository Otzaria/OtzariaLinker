import { LinkerError } from "../core/errors";
import { otzariaBookTitle } from "../core/links/titles";
import { isSafeZipPath } from "../formats/links-json/export";

/*
 * Folder-based book repositories (V7 §4.16, #46), from their file listing alone: which kind of repository a tree is, which files
 * are its books and its links files, and where a book's links file goes. Pure (paths in, a description out): the Node runner
 * (cli/) lists a folder or a ZIP and passes the paths; a plugin could pass its own.
 *
 * The kinds are the two repositories the issue names, read from the public GitHub API on 2026-11-26 as DATA CONTRACTS only
 * (AGENTS.md §2.7: nothing of their code is used), and a plain folder:
 *   zmanenu           Otzaria/zmanenu-library (docs/format.md): library.json at the root; books are source/books/**.txt (the
 *                     file name is the title); ONE links folder, source/links/<title>_links.json; source/editions/<title>/ holds
 *                     editions of a book (same lines), not books; a link to the official library is a record with
 *                     `target_library: "official"`, `book_2` and `heRef_2`
 *   unofficial-books  YairDaniel11/Otzarya-Unofficial-Books (CLAUDE.md §7; docs/research/PERSONAL_DB_BUILD_PIPELINE.md): books are
 *                     ספרים/**.txt; a links/ folder BESIDE the books (281 of the 322 files on that day); סדר.txt orders a folder;
 *                     links to the official library are links.csv files in numbered folders under "ספרים/קבצי קישורים וסדר הדורות"
 *   folder            anything else: every .txt is a book; a top-level links/ folder (as in otzaria-library) takes the new files,
 *                     otherwise a links/ folder beside the book; a link to the official library is a plain `_links.json` record
 * Hidden folders (.git, .github, .claude…) and node_modules are never read.
 */
export type RepoKind = "zmanenu" | "unofficial-books" | "folder";

/** How a link from a book of the repository to a book of the official library is written. */
export type ExternalLinks = "target-library" | "links-csv" | "links-json";

export interface RepoBook {
  /** relative, forward slashes */
  path: string;
  /** the title Otzaria gives the file (core/links/titles.ts otzariaBookTitle, as the text-files source does) */
  title: string;
}

export interface RepoLinksFile {
  path: string;
  /** the source book the file is named after */
  title: string;
}

export interface RepoLayout {
  kind: RepoKind;
  /** where the books are ("" for a plain folder) */
  booksRoot: string;
  books: RepoBook[];
  linksFiles: RepoLinksFile[];
  /** files under the books root that are not books, each with the reason (Hebrew) */
  skipped: { path: string; reason: string }[];
  /** titles more than one file makes: none of them is linked (Otzaria keeps one; which one is not ours to guess) */
  duplicateTitles: { title: string; paths: string[] }[];
  external: ExternalLinks;
  /** unofficial-books: the folder the links.csv folders are in, and the ones there are ("קישורים/01"…) */
  csvRoot?: string;
  csvFolders?: string[];
  /** where the links file of a book goes: its existing file, or the repository's place for a new one */
  linksFileFor(title: string): { path: string; exists: boolean };
}

const LINKS_SUFFIX = "_links.json";
const IGNORED_DIR = (seg: string) => seg.startsWith(".") || seg === "node_modules";
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (...parts: string[]) => parts.filter(Boolean).join("/");
const stem = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);

const UNOFFICIAL_ROOT = "ספרים";
const UNOFFICIAL_CSV = "ספרים/קבצי קישורים וסדר הדורות";
const ZMANENU_BOOKS = "source/books";
const ZMANENU_LINKS = "source/links";

export function detectRepoLayout(paths: readonly string[]): RepoLayout {
  const all: string[] = [];
  for (const raw of paths) {
    const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!isSafeZipPath(p)) throw new LinkerError("repo/not-found", `ברשימת הקבצים של המאגר יש נתיב לא בטוח ("${raw}"). בדקו את התיקייה או את קובץ ה־ZIP.`, { path: raw });
    if (p.split("/").slice(0, -1).some(IGNORED_DIR)) continue;
    all.push(p);
  }
  all.sort(cmp);
  const has = new Set(all);
  const kind: RepoKind = has.has("library.json") && all.some((p) => p.startsWith(`${ZMANENU_BOOKS}/`))
    ? "zmanenu"
    : all.some((p) => p.startsWith(`${UNOFFICIAL_ROOT}/`) && p.endsWith(".txt") && nameOf(p) !== "סדר.txt")
      ? "unofficial-books"
      : "folder";
  const booksRoot = kind === "zmanenu" ? ZMANENU_BOOKS : kind === "unofficial-books" ? UNOFFICIAL_ROOT : "";
  const under = (p: string) => !booksRoot || p.startsWith(`${booksRoot}/`);

  const skipped: RepoLayout["skipped"] = [];
  const candidates: RepoBook[] = [];
  for (const p of all) {
    if (p.endsWith(LINKS_SUFFIX)) continue;
    if (kind === "zmanenu" && p.startsWith("source/editions/") && p.endsWith(".txt")) {
      skipped.push({ path: p, reason: "מהדורה של ספר (source/editions): אותן שורות כמו הספר, ולכן היא לא מקושרת בנפרד." });
      continue;
    }
    if (!under(p)) continue;
    if (kind === "unofficial-books" && p.startsWith(`${UNOFFICIAL_CSV}/`)) continue; // links.csv and דורות.csv: data of the build, not books
    if (!p.endsWith(".txt")) {
      if (booksRoot) skipped.push({ path: p, reason: "אינו קובץ טקסט (.txt), ולכן אינו ספר שאפשר לקשר." });
      continue;
    }
    if (nameOf(p) === "סדר.txt") {
      skipped.push({ path: p, reason: "קובץ הסדר של התיקייה (סדר.txt), לא ספר." });
      continue;
    }
    candidates.push({ path: p, title: otzariaBookTitle(stem(nameOf(p))) });
  }
  const byTitle = new Map<string, RepoBook[]>();
  for (const b of candidates) byTitle.set(b.title, [...(byTitle.get(b.title) ?? []), b]);
  const duplicateTitles = [...byTitle].filter(([, l]) => l.length > 1).map(([title, l]) => ({ title, paths: l.map((b) => b.path) }));
  const dup = new Set(duplicateTitles.map((d) => d.title));
  const books = candidates.filter((b) => !dup.has(b.title));

  const linksFiles = all.filter((p) => p.endsWith(LINKS_SUFFIX) && nameOf(p).length > LINKS_SUFFIX.length).map((p) => ({ path: p, title: nameOf(p).slice(0, -LINKS_SUFFIX.length) }));
  const existing = new Map<string, string>();
  for (const f of linksFiles) if (!existing.has(f.title)) existing.set(f.title, f.path);
  const bookOf = new Map(books.map((b) => [b.title, b]));
  const central = kind === "zmanenu" ? ZMANENU_LINKS : kind === "folder" && linksFiles.some((f) => dirOf(f.path) === "links") ? "links" : null;

  const csvFolders =
    kind === "unofficial-books"
      ? [...new Set(all.filter((p) => p.startsWith(`${UNOFFICIAL_CSV}/`) && p.endsWith("/links.csv")).map((p) => dirOf(p).slice(UNOFFICIAL_CSV.length + 1)))].sort(cmp)
      : undefined;

  return {
    kind,
    booksRoot,
    books,
    linksFiles,
    skipped,
    duplicateTitles,
    external: kind === "zmanenu" ? "target-library" : kind === "unofficial-books" ? "links-csv" : "links-json",
    ...(csvFolders && { csvRoot: UNOFFICIAL_CSV, csvFolders }),
    linksFileFor(title) {
      const at = existing.get(title);
      if (at) return { path: at, exists: true };
      const file = `${title}${LINKS_SUFFIX}`;
      if (central) return { path: join(central, file), exists: false };
      const book = bookOf.get(title);
      return { path: join(book ? dirOf(book.path) : booksRoot, "links", file), exists: false };
    },
  };
}

export interface BookFilter {
  /** keep only books matching one of these: a path glob (`*` within a folder, `**` across folders) or words of the title */
  include?: readonly string[];
  exclude?: readonly string[];
  /** at most this many, in path order */
  limit?: number;
}

/** A glob on the whole path when it has a "/", on the file name otherwise; words without a glob character match the title. */
export function bookMatches(book: RepoBook, pattern: string): boolean {
  if (!/[*?]/.test(pattern) && !pattern.includes("/")) return book.title.includes(pattern);
  const re = new RegExp(`^${pattern.split("**").map((part) => part.split("*").map((s) => s.split("?").map(escapeRe).join("[^/]")).join("[^/]*")).join(".*")}$`);
  return pattern.includes("/") ? re.test(book.path) : re.test(nameOf(book.path));
}

export function filterBooks(books: readonly RepoBook[], f: BookFilter): RepoBook[] {
  let out = books.filter((b) => (!f.include?.length || f.include.some((p) => bookMatches(b, p))) && !f.exclude?.some((p) => bookMatches(b, p)));
  if (f.limit !== undefined) out = out.slice(0, Math.max(0, f.limit));
  return out;
}

/**
 * The folders new links.csv files go to: each produced folder ("קישורים/01", from formats/personal-csv) renumbered after the
 * folders the repository already has under the same root, so an existing file is never replaced.
 */
export function nextCsvFolders(existing: readonly string[], produced: readonly string[]): string[] {
  const used = new Map<string, number>();
  for (const f of existing) {
    const root = dirOf(f);
    const n = Number(nameOf(f));
    if (Number.isFinite(n)) used.set(root, Math.max(used.get(root) ?? 0, n));
  }
  return produced.map((f) => {
    const root = dirOf(f);
    const n = (used.get(root) ?? 0) + 1;
    used.set(root, n);
    return join(root, String(n).padStart(2, "0"));
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
