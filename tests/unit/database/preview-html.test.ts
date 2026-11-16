import { describe, expect, it } from "vitest";
import { looksLikeHtml } from "../../../src/database/generic/preview";

describe("mapping preview: is a sample cell HTML (security review A6)", () => {
  it("recognises tags, not text with < in it", () => {
    expect(looksLikeHtml("<b>שלום</b>")).toBe(true);
    expect(looksLikeHtml('טקסט <span class="x">עם</span> תגית')).toBe(true);
    expect(looksLikeHtml("a < b and c > d")).toBe(false);
    expect(looksLikeHtml("plain")).toBe(false);
  });

  it("a hostile cell of unclosed tags is linear, not quadratic", () => {
    const cell = "<a ".repeat(200_000); // 600 KB, no ">"
    const t = performance.now();
    expect(looksLikeHtml(cell)).toBe(false);
    const full = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/i.test(cell); // the pattern itself, without the 4 KB probe
    expect(full).toBe(false);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
