import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The word "מקור" means three things in the product (the book a link starts from, the link type "מקור", and the file or database
 * the books come from). The third one is said "קובץ" / "מסד" / "קובץ או מסד" in text the user reads, so that "המקור" always
 * means a book's role. This guards the phrases that used it for a file or a database in the screens and the state layer
 * (the other layers' messages are the follow-up listed in docs/reviews/QA_V6_PR3.md). Not a general lint: the roles
 * ("ספר המקור", "שורת המקור", "צד המקור") stay.
 */
const FILE_SENSE = ["באותו מקור", "מקורות שונים", "במקור הזה", "במקור המועדף", "כמקור המועדף", "המקור המועדף", 'המקור "${this.host.sources', "הספרים של מקורות", "מקורות — אפשר"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(n) ? [p] : [];
  });
}

describe("the data file or database is not called 'מקור' in the screens and the state layer", () => {
  it("no phrase that uses it for a file or a database", () => {
    const found: string[] = [];
    for (const f of [...files("src/ui"), ...files("src/state")]) {
      const text = readFileSync(f, "utf8");
      for (const phrase of FILE_SENSE) if (text.includes(phrase)) found.push(`${f}: ${phrase}`);
    }
    expect(found).toEqual([]);
  });

  it("the max-link scope picker names the file or database, not 'המקור'", () => {
    expect(readFileSync("src/ui/workspace/maxlink-panel.tsx", "utf8")).not.toMatch(/<label class="field">\s*המקור\s*</);
  });
});
