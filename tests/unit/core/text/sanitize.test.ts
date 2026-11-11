import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { countVisibleChars } from "../../../../src/core/text/offsets";
import { sanitizeBookHtml } from "../../../../src/core/text/sanitize";

describe("sanitizeBookHtml — XSS (TD-C4)", () => {
  it.each([
    ['<img src=x onerror="alert(1)">', ""],
    ["<svg onload=alert(1)>א</svg>", "א"],
    ['<a href="javascript:alert(1)">קישור</a>', "קישור"],
    ["<script>alert(1)</script>", "alert(1)"],
    ["<style>body{display:none}</style>", "body{display:none}"],
    ['<b onclick="x()" style="color:red">מודגש</b>', "<b>מודגש</b>"],
    ["<iframe src=//evil></iframe>שלום", "שלום"],
    ['<span class="x" data-a=1>א</span>', "<span>א</span>"],
  ])("%s → %s", (input, expected) => expect(sanitizeBookHtml(input)).toBe(expected));

  it("never lets a tag carry an attribute or an event handler", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("<", ">", "b", "img", " ", "on", "=", '"', "x", "/", "&", ";", "א") }), (s) => {
        // every "<" left in the output opens a bare allowlisted tag: no attributes, nothing else
        const tags = sanitizeBookHtml(s).match(/<[^>]*>?/g) ?? [];
        return tags.every((t) => /^<\/?(?:[a-z][a-z0-9]*|x-uncounted)>$/.test(t));
      }),
    );
  });
});

describe("sanitizeBookHtml — book formatting survives", () => {
  it("keeps formatting and headings, normalized", () => {
    expect(sanitizeBookHtml("<H2>פרק א</H2>")).toBe("<h2>פרק א</h2>");
    expect(sanitizeBookHtml("א<br/>ב")).toBe("א<br>ב");
    expect(sanitizeBookHtml("<big><b>ד״ה</b></big> שם")).toBe("<big><b>ד״ה</b></big> שם");
  });
  it("closes tags the line left open and drops stray closers", () => {
    expect(sanitizeBookHtml("<b>א<i>ב")).toBe("<b>א<i>ב</i></b>");
    expect(sanitizeBookHtml("א</b>ב")).toBe("אב");
    expect(sanitizeBookHtml("<b>א<i>ב</b>ג")).toBe("<b>א<i>ב</i></b>ג");
  });
  it("keeps valid entities, escapes a lone & and quotes", () => {
    expect(sanitizeBookHtml("א&amp;ב &#1488; &nbsp;")).toBe("א&amp;ב &#1488; &nbsp;");
    expect(sanitizeBookHtml('א & "ג"')).toBe("א &amp; &quot;ג&quot;");
  });
  it("a '<' with no '>' : the rest stays visible to the user but is marked uncounted (generator rule)", () => {
    expect(sanitizeBookHtml("<b>א < ב")).toBe("<b>א <x-uncounted>&lt; ב</x-uncounted></b>");
  });
});

/** Visible characters of sanitized output, counted the way the browser renders them. */
function renderedLength(html: string): number {
  return html.replace(/<x-uncounted>.*<\/x-uncounted>/s, "").replace(/<[^>]*>/g, "").replace(/&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/g, "_").length;
}

describe("sanitizeBookHtml — anchors stay aligned", () => {
  it("rendered text has exactly as many characters as the generator counts in the raw line", () => {
    const line = fc
      .array(fc.constantFrom("א", "ב", " ", "<b>", "</b>", "<script>", "</script>", "<img src=x>", "&amp;", "&#1488;", "<", "&", ";", ">", '"', "&a b;"), { maxLength: 40 })
      .map((p) => p.join(""));
    fc.assert(fc.property(line, (raw) => renderedLength(sanitizeBookHtml(raw)) === countVisibleChars(raw, raw.length)));
  });
});
