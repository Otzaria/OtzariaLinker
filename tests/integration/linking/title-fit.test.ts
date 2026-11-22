import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import type { EngineBook } from "../../../src/linking/automatic/types";
import { titleFit } from "../../../src/linking/title-fit";
import { engineBook } from "./headings/measure";

/*
 * title-fit.ts on the REAL schema-7 fixture (tests/fixtures/db/seforim-v7-mini.db, the library's own books).
 * The full-library calibration is title-fit.local.test.ts (needs OTZARIA_DB).
 */
const bytes = new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"));
const books = new Map<number, EngineBook>();
const get = (id: number): EngineBook => books.get(id)!;

beforeAll(async () => {
  const reader = await OtzariaDbReader.open(bytesSource(bytes));
  const all = await reader.books();
  for (const b of all) books.set(b.id, engineBook(`db:${b.id}`, b.title, await reader.lines(b.id)));
});

describe("title fit on the real fixture", () => {
  it("אונקלוס on בראשית: the same chapters and verses — fit", () => {
    const r = titleFit(get(3201), get(1));
    expect(r.verdict).toBe("fit");
    expect(r.metrics.titleDensity).toBeGreaterThan(0.8);
    expect(r.metrics.placedShare).toBeGreaterThanOrEqual(0.8);
    expect(r.reasons.every((x) => x.ok)).toBe(true);
  });

  it("a book against an unrelated one: no title of it is the other's — unfit, with the reason in Hebrew", () => {
    const r = titleFit(get(3201), get(8441));
    expect(r.verdict).toBe("unfit");
    expect(r.reasons.some((x) => !x.ok && /[א-ת]/.test(x.text))).toBe(true);
  });

  it("is deterministic", () => {
    expect(titleFit(get(3201), get(1))).toEqual(titleFit(get(3201), get(1)));
  });
});
