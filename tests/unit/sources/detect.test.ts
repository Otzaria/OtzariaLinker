import { describe, expect, it } from "vitest";
import { decodeText } from "../../../src/core/text/decode";
import { detectKind } from "../../../src/sources/detect";

const u8 = (s: string) => new TextEncoder().encode(s);

describe("detectKind — by content, not by extension", () => {
  it("SQLite by its header even when named .txt", () => {
    expect(detectKind(u8("SQLite format 3\u0000rest"), "x.txt")).toBe("sqlite");
  });
  it("ZIP by its signature even when named .db", () => {
    expect(detectKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]), "x.db")).toBe("zip");
  });
  it("Otzaria links JSON (with BOM)", () => {
    expect(detectKind(u8('﻿[{"line_index_1": 1, "path_2": "x.txt", "Conection Type": "commentary"}]'))).toBe("links-json");
  });
  it("saved project", () => {
    expect(detectKind(u8('{"format": "otzaria-linker-project", "version": 1}'))).toBe("project");
  });
  it("other JSON", () => expect(detectKind(u8('{"a": 1}'))).toBe("json"));
  it("TSV by structure; a .txt with tabs stays text", () => {
    expect(detectKind(u8("a\tb\tc\n1\t2\t3"), "data")).toBe("tsv");
    expect(detectKind(u8("a\tb\tc"), "book.txt")).toBe("text");
  });
  it("CSV by extension", () => expect(detectKind(u8("a,b\n1,2"), "x.csv")).toBe("csv"));
  it("book text", () => expect(detectKind(u8("<h1>בראשית</h1>\nבראשית ברא"), "בראשית.txt")).toBe("text"));
  it("binary", () => expect(detectKind(new Uint8Array([1, 0, 2, 0, 0, 0, 7, 0, 0, 9]))).toBe("binary"));
  it("UTF-16LE text is not binary", () => {
    const b = new Uint8Array([0xff, 0xfe, 0xe9, 0x05, 0xdc, 0x05]);
    expect(detectKind(b, "x.txt")).toBe("text");
  });
});

describe("decodeText", () => {
  it("UTF-8 with and without BOM", () => {
    expect(decodeText(u8("﻿שלום"))).toEqual({ text: "שלום", encoding: "utf-8", hadBom: true });
    expect(decodeText(u8("שלום")).encoding).toBe("utf-8");
  });
  it("UTF-16LE with BOM and without", () => {
    const body = [0xe9, 0x05, 0xdc, 0x05, 0xd5, 0x05, 0xdd, 0x05];
    expect(decodeText(new Uint8Array([0xff, 0xfe, ...body])).text).toBe("שלום");
    const long = new Uint8Array(Array.from({ length: 8 }, () => body).flat());
    expect(decodeText(long)).toMatchObject({ encoding: "utf-16le", text: "שלום".repeat(8) });
  });
  it("legacy windows-1255", () => {
    expect(decodeText(new Uint8Array([0xf9, 0xec, 0xe5, 0xed]))).toMatchObject({ text: "שלום", encoding: "windows-1255" });
  });
});
