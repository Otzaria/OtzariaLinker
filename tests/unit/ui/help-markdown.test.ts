import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_BASE, renderGuide, slug } from "../../../src/ui/help/markdown";

describe("help: the guide rendered inside the tool", () => {
  const guide = readFileSync(resolve("docs/USER_GUIDE.md"), "utf8");
  const r = renderGuide(guide);

  it("every in-guide link points at a heading that exists", () => {
    expect(r.anchors.length).toBeGreaterThan(0);
    expect(r.anchors.filter((a) => !r.ids.has(a))).toEqual([]);
    // including the guide's own table of contents, which the help replaces but GitHub shows
    const all = [...guide.matchAll(/\]\(#([^)]+)\)/g)].map((m) => decodeURIComponent(m[1]!));
    expect(all.length).toBeGreaterThanOrEqual(14);
    expect(all.filter((a) => !r.ids.has(a))).toEqual([]);
  });

  it("the side navigation lists the numbered chapters, without the guide's own table of contents", () => {
    expect(r.toc.length).toBeGreaterThanOrEqual(14);
    expect(r.toc[0]!.text).toMatch(/^1\. /);
    expect(r.toc.some((t) => t.text === "תוכן")).toBe(false);
  });

  it("no Markdown syntax leaks into the text", () => {
    const text = r.html.replace(/<code>[\s\S]*?<\/code>/g, "").replace(/<pre[\s\S]*?<\/pre>/g, "");
    expect(text).not.toMatch(/\*\*|\]\(|^\||\|---|^#/m);
    expect(text).not.toContain("&lt;kbd");
  });

  it("only <kbd> survives from the source; any other HTML is shown as text", () => {
    const x = renderGuide('a <img src=x onerror=alert(1)> <kbd>F1</kbd> `<sup>` [x](javascript:alert(1)) [y](https://e.org/a"b)').html;
    expect(x).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(x).toContain("<kbd>F1</kbd>");
    expect(x).toContain("<code>&lt;sup&gt;</code>");
    expect(x).not.toContain("javascript:");
    expect(x).not.toMatch(/<(?!\/?(p|kbd|code|a)\b)/);
  });

  it("links: anchors, other docs, and the web", () => {
    const x = renderGuide("[א](#שלום-עולם) [ב](IMPORT_EXPORT.md) [ג](https://github.com/Otzaria) [ד](../x.md)").html;
    expect(x).toContain('href="#שלום-עולם" data-anchor="שלום-עולם"');
    expect(x).toContain(`href="${DOCS_BASE}IMPORT_EXPORT.md" target="_blank" rel="noopener noreferrer"`);
    expect(x).toContain('href="https://github.com/Otzaria" target="_blank"');
    expect(x).not.toContain("../x.md");
  });

  it("blocks: tables, lists with continuation lines, code", () => {
    const x = renderGuide(["| א | `a\\|b` |", "|---|---|", "| 1 | 2 |", "", "1. one", "   more", "2. two", "", "```", "<x>", "```"].join("\n")).html;
    expect(x).toContain("<thead><tr><th>א</th><th><code>a|b</code></th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>");
    expect(x).toContain("<ol><li>one more</li><li>two</li></ol>");
    expect(x).toContain('<pre dir="ltr"><code>&lt;x&gt;</code></pre>');
  });

  it("slugs follow GitHub", () => {
    expect(slug("6. הבונה: יצירת קישור ועריכה")).toBe("6-הבונה-יצירת-קישור-ועריכה");
    expect(slug("11. פרויקטים, שמירה אוטומטית ושחזור")).toBe("11-פרויקטים-שמירה-אוטומטית-ושחזור");
    expect(slug("קישורים `ref_1`")).toBe("קישורים-ref_1");
  });
});
