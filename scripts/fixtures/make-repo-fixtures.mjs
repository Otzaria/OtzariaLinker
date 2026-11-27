// Writes the two folder-repository fixtures of tests/fixtures/repos/ (V7 §4.16, #46; docs/HEADLESS.md).
//   node scripts/fixtures/make-repo-fixtures.mjs
// The STRUCTURE mirrors the real repositories as read from the public GitHub API on 2026-11-26 (read only, nothing cloned):
// Otzaria/zmanenu-library (library.json, source/books, source/links, source/editions; docs/format.md) and
// YairDaniel11/Otzarya-Unofficial-Books (ספרים/<category>/…, links/ beside the books, סדר.txt, numbered links.csv folders).
// The TEXTS are made here, not copied: a base of distinct words and a commentary quoting each line's opening words (the pair of
// tests/unit/linking/adapters.test.ts), and commentaries on בראשית shaped like the guided-flow test's, which link to the real
// slice of the official database (tests/fixtures/db/seforim-v7-mini.db). Deterministic: running it again writes the same bytes.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "repos");
const LETTERS = "אבגדהוזחטיכלמנסעפצקרשת";
const word = (n) => {
  let s = "";
  for (let k = 0; k < 3; k++, n = Math.floor(n / LETTERS.length)) s += LETTERS[n % LETTERS.length];
  return s;
};
const heb = (n) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n];

/** a base and a commentary quoting the opening words of each line, under the same chapter headings */
function pair(title, n, seed) {
  const base = [`<h1>${title}</h1>`];
  const comm = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) {
      const h = `<h2>פרק ${heb(i / 10 + 1)}</h2>`;
      base.push(h);
      comm.push(h);
    }
    const w = [0, 1, 2, 3, 4, 5].map((k) => word(seed + 6 * i + k));
    base.push(w.join(" "));
    comm.push(`<b>${w[0]} ${w[1]} ${w[2]}.</b> פירוש`);
  }
  return { base, comm };
}
/** a commentary on בראשית chapter א, a heading per verse (links by headings to the official book) */
const onBereshit = (title) => [`<h1>${title}</h1>`, "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()];

const files = new Map();
const put = (path, text) => files.set(path, text);
const lines = (arr) => arr.join("\n");

// ---- zmanenu-library
{
  const R = "zmanenu";
  put(`${R}/library.json`, JSON.stringify({ library_id: "otzaria.zmanenu-fixture", library_name: "מחברי זמננו (בדיקה)", library_folder: "מחברי זמננו", description: "fixture of tests/fixtures/repos", db_file_name: "zmanenu.db" }, null, 2) + "\n");
  put(`${R}/source/categories.json`, "{}\n");
  put(`${R}/source/metadata.json`, "{}\n");
  const p = pair("ספר לדוגמה", 30, 100);
  put(`${R}/source/books/הלכה/ספר לדוגמה.txt`, lines(p.base));
  put(`${R}/source/books/הלכה/ביאור על ספר לדוגמה.txt`, lines([`<h1>ביאור על ספר לדוגמה</h1>`, ...p.comm]));
  put(`${R}/source/books/תנ״ך/ביאור לדוגמה על בראשית.txt`, lines(onBereshit("ביאור לדוגמה על בראשית")));
  put(`${R}/source/books/דברי פתיחה.txt`, lines(["<h1>דברי פתיחה</h1>", "דברים בעלמא."]));
  put(`${R}/source/editions/ספר לדוגמה/מהדורה מנוקדת.txt`, lines(p.base));
  // an existing file in the zmanenu format (which the official format does not read whole): a book_2 record to a book of the
  // repository, and a target_library record the run would make again (line 4 is "ביאור לפסוק 1", on בראשית א, א)
  put(
    `${R}/source/links/ביאור לדוגמה על בראשית_links.json`,
    JSON.stringify(
      [
        { line_index_1: 2, line_index_2: 2, book_2: "ספר לדוגמה", "Conection Type": "reference" },
        { line_index_1: 4, target_library: "official", book_2: "בראשית", heRef_2: "בראשית, א, א", "Conection Type": "source" },
      ],
      null,
      2,
    ) + "\n",
  );
}

// ---- Otzarya-Unofficial-Books
{
  const R = "unofficial-books";
  put(`${R}/manifest.json`, "{}\n");
  put(`${R}/ספרים/סדר.txt`, lines(["משנה", "תנ״ך"]));
  put(`${R}/ספרים/משנה/סדר.txt`, lines(["ספר בסיס לדוגמה", "מפרשים"]));
  const p = pair("ספר בסיס לדוגמה", 30, 5000);
  put(`${R}/ספרים/משנה/ספר בסיס לדוגמה.txt`, lines(p.base));
  put(`${R}/ספרים/משנה/מפרשים/פירוש על ספר בסיס לדוגמה.txt`, lines([`<h1>פירוש על ספר בסיס לדוגמה</h1>`, ...p.comm]));
  put(`${R}/ספרים/משנה/מפרשים/ביאור ישן על ספר בסיס לדוגמה.txt`, lines([`<h1>ביאור ישן על ספר בסיס לדוגמה</h1>`, ...p.comm]));
  // an existing links file of the official format, beside the books: it is loaded, and written back with its records untouched
  put(`${R}/ספרים/משנה/מפרשים/links/ביאור ישן על ספר בסיס לדוגמה_links.json`, JSON.stringify([{ line_index_1: 3, heRef_2: "ספר בסיס לדוגמה 3", path_2: "ספר בסיס לדוגמה.txt", line_index_2: 3, "Conection Type": "source" }], null, 2));
  put(`${R}/ספרים/תנ״ך/מפרשים/ביאור חדש על בראשית.txt`, lines(onBereshit("ביאור חדש על בראשית")));
  put(`${R}/ספרים/קבצי קישורים וסדר הדורות/דורות.csv`, "﻿ספר,דור,מחבר,קטגוריה\r\n");
  put(`${R}/ספרים/קבצי קישורים וסדר הדורות/קישורים/01/links.csv`, "﻿מקור,ספר_מקור,מקור_אישי,ספר_יעד,מיקום_יעד,סוג,יעד_אישי,קטגוריית_מקור\r\n3,ספר ישן,כן,בראשית,פרק א,פירוש,לא,\r\n");
}

for (const dir of ["zmanenu", "unofficial-books"]) rmSync(join(ROOT, dir), { recursive: true, force: true });
for (const [path, text] of files) {
  const abs = join(ROOT, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}
console.log(`wrote ${files.size} files under ${ROOT}`);
