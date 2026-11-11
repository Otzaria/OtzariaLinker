import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { LinkerError } from "../../../src/core/errors";
import { safeArchivePath, safeUnzip } from "../../../src/sources/archives/safe-unzip";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return "no-error";
  } catch (e) {
    return e instanceof LinkerError ? e.code : `foreign: ${String(e)}`;
  }
};

describe("safeArchivePath", () => {
  it.each([
    ["books/בראשית.txt", "books/בראשית.txt"],
    ["./a/./b.txt", "a/b.txt"],
    ["a\\b.txt", "a/b.txt"],
  ])("accepts %s", (input, expected) => expect(safeArchivePath(input)).toBe(expected));

  it.each(["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/Windows/x", "c:evil", "a/\u0000b", ""])(
    "rejects %j",
    (input) => expect(safeArchivePath(input)).toBeNull(),
  );
});

describe("safeUnzip", () => {
  it("extracts a normal archive with Hebrew names", () => {
    const zip = zipSync({ "ספרים/בראשית.txt": strToU8("בראשית ברא"), "ספרים/בראשית_links.json": strToU8("[]") });
    const out = safeUnzip(zip);
    expect(out.map((e) => e.path).sort()).toEqual(["ספרים/בראשית.txt", "ספרים/בראשית_links.json"]);
    expect(new TextDecoder().decode(out.find((e) => e.path.endsWith(".txt"))!.bytes)).toBe("בראשית ברא");
  });

  it("include() filters entries without failing", () => {
    const zip = zipSync({ "a.txt": strToU8("a"), "b.bin": new Uint8Array([1, 2]) });
    expect(safeUnzip(zip, { include: (p) => p.endsWith(".txt") }).map((e) => e.path)).toEqual(["a.txt"]);
  });

  it("ZIP Slip: refuses an entry that escapes the root", () => {
    const zip = zipSync({ "../evil.txt": strToU8("x") });
    expect(codeOf(() => safeUnzip(zip))).toBe("archive/unsafe-path");
  });

  it("ZIP Bomb: aborts on a suspicious compression ratio while inflating", () => {
    const zip = zipSync({ "zeros.txt": new Uint8Array(64 * 1024 ** 2) }, { level: 9 });
    expect(zip.length).toBeLessThan(1024 ** 2);
    expect(codeOf(() => safeUnzip(zip))).toBe("archive/suspicious-ratio");
  });

  it("aborts once the per-entry size limit is crossed", () => {
    const zip = zipSync({ "a.txt": new Uint8Array(3 * 1024 ** 2).fill(65) }, { level: 0 });
    expect(codeOf(() => safeUnzip(zip, { limits: { maxEntryBytes: 1024 ** 2 } }))).toBe("archive/too-large");
  });

  it("caps the number of entries", () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, strToU8("x")]));
    expect(codeOf(() => safeUnzip(zipSync(files), { limits: { maxEntries: 10 } }))).toBe("archive/too-many-entries");
  });

  it("reports a damaged archive as corrupt, never as a foreign exception", () => {
    const zip = zipSync({ "a.txt": new Uint8Array(200_000).map((_, i) => (i * 7919) % 251) });
    const broken = zip.slice();
    for (let i = 60; i < 400; i++) broken[i] = 0xff;
    expect(codeOf(() => safeUnzip(broken))).toBe("archive/corrupt");
  });
});
