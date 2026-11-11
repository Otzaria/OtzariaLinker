import { describe, expect, it } from "vitest";
import { decodeRecord } from "../../../src/database/sqlite/lazy/record";

describe("record text keeps a leading BOM (25 real lines start with one)", () => {
  it("U+FEFF at the start of a TEXT value is not swallowed by the decoder", () => {
    const text = new TextEncoder().encode("﻿שלום");
    const serial = text.length * 2 + 13; // TEXT serial type
    const rec = new Uint8Array([2, serial, ...text]);
    expect(decodeRecord(rec, 1)).toEqual(["﻿שלום"]);
  });
});
