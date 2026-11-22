import { describe, expect, it } from "vitest";
import { humanCsvCell } from "../../../src/core/csv";

describe("humanCsvCell", () => {
  it("quotes everything, doubles quotes, prefixes a quote on formula starts, leaves numbers and ordinary text", () => {
    expect(humanCsvCell("שלום")).toBe('"שלום"');
    expect(humanCsvCell('say "hi"')).toBe('"say ""hi"""');
    for (const s of ["=1", "+1", "-1", "@a", "\tx", "\rx"]) expect(humanCsvCell(s)).toBe(`"'${s}"`);
    expect(humanCsvCell(-5)).toBe('"-5"');
    expect(humanCsvCell(undefined)).toBe('""');
    expect(humanCsvCell("a=b")).toBe('"a=b"');
  });
});
