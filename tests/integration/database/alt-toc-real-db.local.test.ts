import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { readAltToc } from "../../../src/database/otzaria/alt-toc-reader";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import type { ByteSource } from "../../../src/database/sqlite/lazy/byte-source";

/*
 * alt_toc of non-Sefaria books in a real seforim.db — structures that came from Otzaria's own
 * alt_toc files (ספר העיטור: "Dapim", תרגום ותפסיר רס"ג: "Parasha"). Runs only with a real database:
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/database/alt-toc-real-db.local.test.ts
 * The file is opened read-only ("r") and never written.
 */
const path = process.env.OTZARIA_DB;
const fd = path ? openSync(path, "r") : -1;
const source: ByteSource | null = path
  ? {
      size: fstatSync(fd).size,
      async read(offset, length) {
        const buf = new Uint8Array(length);
        return buf.subarray(0, readSync(fd, buf, 0, length, offset));
      },
    }
  : null;
afterAll(() => void (path && closeSync(fd)));

describe.runIf(path)("alt_toc in the real seforim.db (read-only)", () => {
  async function structuresOf(title: string) {
    const reader = await OtzariaDbReader.open(source!);
    const book = (await reader.books()).find((b) => b.title === title)!;
    expect(book.source).not.toMatch(/sefaria/i);
    const index = new Map((await reader.lineEntries(book.id)).map((e) => [e.id, e.index]));
    return (await readAltToc(reader.file, book.id, (id) => index.get(id)))!;
  }

  it("תרגום ותפסיר רסג: Parasha, flat, in Torah order", async () => {
    const [s] = await structuresOf('תרגום ותפסיר רסג');
    expect(s).toMatchObject({ key: "Parasha", heTitle: "פרשה", skipped: 0 });
    expect(s!.entries.slice(0, 3)).toEqual([{ heTitle: "בראשית", line: 5, level: 0 }, { heTitle: "נח", line: 302, level: 0 }, { heTitle: "לך לך", line: 614, level: 0 }]);
    expect(s!.entries).toHaveLength(54);
  });

  it("ספר העיטור: Dapim, every entry with a line", async () => {
    const [s] = await structuresOf("ספר העיטור");
    expect(s).toMatchObject({ key: "Dapim", heTitle: "דפים", skipped: 0 });
    expect(s!.entries).toHaveLength(307);
    expect(s!.entries.every((e) => e.line >= 1 && e.heTitle.length > 0)).toBe(true);
  });
});
