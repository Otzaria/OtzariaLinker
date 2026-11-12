import { describe, expect, it } from "vitest";
import { anchorLabelFromHeRef, withAnchorLabel } from "../../../../src/core/text/anchor-label";
import { headingLevel, isHeading, stripTags } from "../../../../src/core/text/html";

describe("כותרות ועוגן (legacy §10)", () => {
  it("זיהוי שורת כותרת", () => {
    expect(isHeading("<h2>פרק א</h2>")).toBe(true);
    expect(isHeading("טקסט")).toBe(false);
    expect(headingLevel("<H3 class=x>א</H3>")).toBe(3);
  });
  it("only a line that STARTS with <hN is a heading (generator detectHeaderLevel)", () => {
    expect(headingLevel(" <h2>א</h2>")).toBeNull();
    expect(headingLevel("<b><h2>א</h2></b>")).toBeNull();
    expect(headingLevel("טקסט <h2>א</h2>")).toBeNull();
    expect(headingLevel("<h2x>")).toBe(2);
  });
  it('חילוץ סמן מ-heRef ("… אות ג" → ג)', () => {
    expect(anchorLabelFromHeRef("שער הציון, סימן א אות ג")).toBe("ג");
  });
  it("withAnchorLabel לא מכפיל סמן קיים", () => {
    expect(withAnchorLabel("א אות ג", "ד")).toBe("א אות ג");
    expect(withAnchorLabel("א", "ד")).toBe("א אות ד");
  });
  it("stripTags decodes common entities", () => {
    expect(stripTags("<b>א</b>&amp;&nbsp;ב")).toBe("א& ב");
  });
});
