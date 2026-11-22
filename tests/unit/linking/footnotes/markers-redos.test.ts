import { describe, expect, it } from "vitest";
import { detectMarkers } from "../../../../src/linking/automatic/footnotes";

/*
 * QA round 2, G: the tag patterns of the marker detector took `[^>]*` after the tag name. On a line of
 * "<b " repeated (no ">" anywhere) every "<b" scans to the end of the line: quadratic, 9.5 s on 300 KB.
 */
describe("marker detection is linear on a line of unterminated tags", () => {
  const evil = (unit: string) => unit.repeat(Math.ceil(300_000 / unit.length));
  it("<b repeated, with a <b> style, with a label element and with the sup/paren auto detection", () => {
    for (const [line, style] of [[evil("<b "), "bold"], [evil("<b "), { tag: "b" }], [`data-label ${evil("<i ")}`, "auto"], [evil("<sup "), "sup"]] as const) {
      const t0 = performance.now();
      detectMarkers(line, style as never);
      expect(performance.now() - t0, `${String(style)} ${line.slice(0, 12)}`).toBeLessThan(1500);
    }
  });
  it("an ordinary tag with attributes is still found", () => {
    const line = 'א <b class="x">12</b> ב';
    expect(detectMarkers(line, { tag: "b" }).map((m) => m.key)).toEqual(["12"]);
  });
});
