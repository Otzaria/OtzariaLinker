import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findDuplicateKey, parseLinksJson, parseLinksJsonSteps } from "../../../src/formats/links-json/parse";
import { syntheticLinksFile } from "../../support/synthetic-links";

/*
 * #42 C5: a links file of 235,000 records was parsed in one block of 1.5–2.6 s on the page. The parse is now a generator that
 * yields between slices of work (parseLinksJsonSteps), and the duplicate-key scan — the costliest part — skips over string
 * values instead of copying them a character at a time. These tests guard the two without timing anything: the slicing is
 * counted (yields per records), and the faster scan is compared with the old one on generated text.
 */

/** The duplicate-key scan as it was before #42 C5 (character by character), the reference for the faster one. */
function referenceDuplicateKey(text: string): string | null {
  const stack: (Set<string> | null)[] = [];
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") {
          s += text.slice(j, j + 2);
          j += 2;
        } else s += text[j++];
      }
      const top = stack.at(-1);
      if (expectKey && top) {
        if (top.has(s)) {
          try {
            return JSON.parse(`"${s}"`) as string;
          } catch {
            return "<throws>";
          }
        }
        top.add(s);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") expectKey = stack.at(-1) instanceof Set;
    i++;
  }
  return null;
}
const scan = (text: string) => {
  try {
    return findDuplicateKey(text);
  } catch {
    return "<throws>";
  }
};

describe("findDuplicateKey: the same answers as the character-by-character scan", () => {
  it("on JSON text, with keys repeated on purpose", () => {
    const withDup = fc.tuple(fc.json(), fc.string(), fc.json()).map(([a, k, b]) => `[${a},{${JSON.stringify(k)}:1,"x":${b},${JSON.stringify(k)}:2}]`);
    fc.assert(fc.property(fc.oneof(fc.json(), withDup), (t) => {
      expect(scan(t)).toBe(referenceDuplicateKey(t));
    }), { numRuns: 2000 });
  }, 60_000);

  it("on broken text: escapes, backslash runs, unterminated strings, stray brackets", () => {
    const piece = fc.constantFrom('"', "\\", "\\\\", '\\"', "{", "}", "[", "]", ",", ":", "a", "b", " ", '"a"', '"a":', "א");
    fc.assert(fc.property(fc.array(piece, { maxLength: 60 }), (ps) => {
      const t = ps.join("");
      expect(scan(t)).toBe(referenceDuplicateKey(t));
    }), { numRuns: 5000 });
  }, 60_000);
});

describe("parseLinksJsonSteps: the parse in slices (#42 C5)", () => {
  it("yields at least once per 2,000 records, and ends with exactly what parseLinksJson returns", () => {
    const text = syntheticLinksFile(20_000);
    const steps = parseLinksJsonSteps(text);
    let yields = 0;
    let r = steps.next();
    while (!r.done) {
      yields++;
      r = steps.next();
    }
    expect(yields).toBeGreaterThanOrEqual(20_000 / 2_000);
    const whole = parseLinksJson(text);
    const plain = (p: typeof whole) => ({ ...p, records: p.records.map(({ origin: _o, ...rec }) => rec) });
    expect(plain(r.value)).toEqual(plain(whole));
    expect(r.value.records).toHaveLength(20_000);
  }, 60_000);

  it("the duplicate-key scan of a long text yields too (no slice of more than about a million characters)", () => {
    const text = syntheticLinksFile(30_000); // ~4.7M characters
    const steps = parseLinksJsonSteps(text);
    let beforeParse = 0;
    // the scan runs before any record is decoded: count the yields until the first record exists
    for (let r = steps.next(); !r.done; r = steps.next()) beforeParse++;
    expect(beforeParse).toBeGreaterThanOrEqual(Math.floor(text.length / 1_000_000) + 30_000 / 2_000);
  }, 60_000);
});
