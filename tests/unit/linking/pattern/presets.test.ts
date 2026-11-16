import { describe, expect, it } from "vitest";
import { MAX_PATTERN_LENGTH } from "../../../../src/core/text/safe-regex";
import { compilePattern, PATTERN_PRESETS, readReferences } from "../../../../src/linking/automatic/pattern";

/*
 * Every preset is documented by its own examples (pattern/presets.ts): each example must read exactly
 * the path written next to it, and each reject must read nothing. The daf presets are read with
 * "ברכות" as the target, so their "another tractate" guard is on.
 */
describe("the structure presets read what their documentation says", () => {
  for (const p of PATTERN_PRESETS) {
    describe(`${p.id} (${p.name})`, () => {
      it("is a valid template a user could open and edit", () => {
        expect(p.template.length).toBeLessThanOrEqual(MAX_PATTERN_LENGTH);
        const c = compilePattern(p.template);
        expect(c.ok ? "" : c.reason).toBe("");
      });
      for (const [text, path] of p.examples)
        it(`"${text}" → ${path}`, () => {
          expect(readReferences(text, p.id, "ברכות")).toEqual([path]);
        });
      for (const text of p.rejects)
        it(`"${text}" → nothing`, () => {
          expect(readReferences(text, p.id, "ברכות")).toEqual([]);
        });
    });
  }
});
