import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * V7 §3.5, issue 19: the side of a link is named by the task (state/roles.ts) — "הספר המקשר / הספר המקושר", "גוף הספר /
 * ספר ההערות", "ספר הפירוש / ספר הבסיס", "הספר המפנה / הספר המצוטט" — and "מקור" is a file or a database ("מקור נתונים"),
 * never a book's role. This scans the strings of the screens, the state and the user-facing errors for the old role words
 * ("ספר המקור", "ספר היעד", "צד המקור", "שורת היעד"…), outside comments.
 *
 * NOT_YET: files another change is rewriting at the same time; each is listed with what is left there, so it is not lost.
 */
const ROOTS = ["src/ui", "src/state", "src/core/errors.ts"];
const NOT_YET: Record<string, string> = {};
// a role word is followed by no Hebrew letter ("מקורי", "מקורות", "ייעדרו" are other words); JavaScript's \b knows only ASCII
const ROLE_WORDS = /(?:ספר|ספרי|צד|שורת|חלונית) ה?(?:מקור|יעד)(?![א-ת])|(?:^|[^א-ת])(?:ב|מה)(?:מקור|יעד)(?![א-ת])|ספר ושורת (?:מקור|יעד)|החלפת יעד|יעד חדש/;

function files(p: string): string[] {
  if (statSync(p).isFile()) return /\.(ts|tsx)$/.test(p) ? [p] : [];
  return readdirSync(p).flatMap((f) => files(join(p, f)));
}

/** The lines of code, without comments (a line that is a comment, and the comment at the end of a line). */
function codeLines(text: string): { n: number; line: string }[] {
  const out: { n: number; line: string }[] = [];
  let block = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    if (block) {
      const end = line.indexOf("*/");
      if (end < 0) return;
      line = line.slice(end + 2);
      block = false;
    }
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) return;
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) block = true;
      return;
    }
    out.push({ n: i + 1, line: line.replace(/\s\/\/ .*$/, "") });
  });
  return out;
}

describe("terminology (V7 §3.5)", () => {
  it("no screen calls a side of a link 'מקור' or 'יעד': the roles module names it by the task", () => {
    const found: string[] = [];
    for (const root of ROOTS)
      for (const f of files(root)) {
        const rel = relative(".", f).replaceAll("\\", "/");
        if (rel in NOT_YET || rel.endsWith("icon-data.ts")) continue;
        for (const { n, line } of codeLines(readFileSync(f, "utf8"))) if (ROLE_WORDS.test(line)) found.push(`${rel}:${n}: ${line.trim().slice(0, 140)}`);
      }
    expect(found).toEqual([]);
  });
});
