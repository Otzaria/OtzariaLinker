import { describe, expect, it } from "vitest";
import { anchorLabelFromHeRef, anchorLabelProblem, replaceAnchorLabel } from "../../../../src/core/text/anchor-label";

/*
 * The builder's anchor label (v3 F-075, the "סמן" dialog): the label lives in heRef_2 as " אות X", which is where the
 * generator reads it (anchorLabelFromHeRef, Generator.kt:2425). Changing it replaces the old one instead of appending
 * a second, and a label the generator would not read is refused before it is written.
 */
describe("replacing the anchor label in heRef_2", () => {
  it("appends, replaces and removes ' אות X'", () => {
    expect(replaceAnchorLabel("משנה ברורה, סימן א", "ג")).toBe("משנה ברורה, סימן א אות ג");
    expect(replaceAnchorLabel("משנה ברורה, סימן א אות ג", "ד")).toBe("משנה ברורה, סימן א אות ד");
    expect(replaceAnchorLabel("משנה ברורה, סימן א אות ג", "")).toBe("משנה ברורה, סימן א");
    expect(replaceAnchorLabel("משנה ברורה, סימן א", null)).toBe("משנה ברורה, סימן א");
    // what is written is what the generator reads back
    expect(anchorLabelFromHeRef(replaceAnchorLabel("שער הציון, סימן א", 'י"א'))).toBe('י"א');
  });

  it("a ' אות ' the generator does not read as a label is part of the reference, and stays", () => {
    // "אות 12" is not a label (digits): the generator ignores it, so replacing must not cut it off
    expect(replaceAnchorLabel("ספר האותיות אות 12", "ב")).toBe("ספר האותיות אות 12 אות ב");
  });
});

describe("which labels the generator reads", () => {
  it("one to six Hebrew letters or quote marks; anything else has a reason", () => {
    for (const ok of ["א", "ג", 'י"א', "קכג", "א׳"]) expect(anchorLabelProblem(ok)).toBeNull();
    for (const bad of ["12", "abc", "אבגדהוז", "א ב"]) expect(anchorLabelProblem(bad)).toMatch(/אותיות/);
    expect(anchorLabelProblem("")).toBeNull(); // empty = no label
  });
});
