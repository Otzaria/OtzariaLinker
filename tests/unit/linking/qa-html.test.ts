import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import type { ValidationContext } from "../../../src/core/links/validate";
import { categoryOf, QA_CATEGORIES, runQa, suggestedFix, type QaCategory } from "../../../src/linking/qa";
import { buildQaHtml } from "../../../src/linking/qa-html";

const A: BookRef = { key: "a", title: "פירוש", origin: "otzaria", isBaseBook: false };
const B: BookRef = { key: "b", title: "בסיס", origin: "otzaria", isBaseBook: false };
const ctx: ValidationContext = { lineCount: () => 10, line: (_b, i) => ({ exists: true, heading: i === 0 ? 1 : null, anchorLength: 20 }) };
const mk = (id: string, over: Partial<Link> = {}): Link => ({ id, status: "new", provenance: "user", source: { book: A, line: 2 }, target: { book: B, line: 3 }, declaredType: "commentary", heRef2: "בסיס ד", ...over });

const small = runQa(
  [
    mk("ok"),
    mk("dup"),
    mk("head", { target: { book: B, line: 0 } }),
    mk("far", { source: { book: A, line: 4, end: 6 }, target: { book: B, line: 40 } }),
    mk("type", { declaredType: "commantary" }),
  ],
  ctx,
);
const html = (report = small) => buildQaHtml({ report, date: "12.11.2026", app: "2.0.0-test" });

describe("QA report as HTML", () => {
  it("golden: a small report", async () => {
    await expect(html()).toMatchFileSnapshot("__snapshots__/qa-report.golden.html");
  });

  it("is deterministic for the same input", () => {
    expect(html()).toBe(html());
  });

  it("is one offline page: no script, no external resource, and a CSP that forbids them", () => {
    const out = html();
    expect(out).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|https?:/i);
    expect(out).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    expect(out).toMatch(/^<!doctype html>\n<html lang="he" dir="rtl">/);
    expect(out).toContain("prefers-color-scheme:dark");
  });

  it("groups by severity, then by category, errors first", () => {
    const out = html();
    const at = (s: string) => out.indexOf(s);
    expect(at('<section class="error">')).toBeGreaterThan(0);
    expect(at('<section class="error">')).toBeLessThan(at('<section class="warning">'));
    // inside the warnings: duplicate comes before type (QA_CATEGORIES order)
    const warn = out.slice(at('<section class="warning">'));
    expect(warn.indexOf(QA_CATEGORIES.duplicate.title)).toBeLessThan(warn.indexOf(QA_CATEGORIES.type.title));
    expect(out).not.toContain('<section class="info">'); // no info issue → no empty section
  });

  it("shows every issue with places (1-based, ranges), heRef_2, the code and a suggested fix", () => {
    const out = html();
    expect(out).toContain("<td><bdi>פירוש</bdi> 5–7</td><td><bdi>בסיס</bdi> 41</td>");
    expect(out).toContain("<code>export/heading-line</code>");
    expect(out).toContain(suggestedFix("export/heading-line"));
    expect(out.match(/<td><code>/g)!.length).toBe(small.issues.length);
  });

  it("summarizes counts per severity, per category and per book", () => {
    const out = html();
    expect(out).toContain(`<div class="tile"><b>${small.checked}</b><span class="muted">קישורים נבדקו</span></div>`);
    expect(out).toContain(`<div class="tile error"><b>${small.bySeverity.error}</b>`);
    expect(out).toContain("<td><bdi>פירוש</bdi></td>");
    expect(out).toContain("12.11.2026");
  });

  it("book text cannot inject markup: a hostile title, heRef_2 and type come out inert", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const E: BookRef = { ...A, key: "e", title: evil };
    const report = runQa([mk("x", { source: { book: E, line: 2 }, target: { book: B, line: 0 }, heRef2: `"><script>alert(2)</script>`, declaredType: "a'b&c" })], ctx);
    const out = html(report);
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).toContain("&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(out).toContain("a&#39;b&amp;c");
  });

  it("an empty report says there is nothing to fix", () => {
    const out = html(runQa([mk("ok")], ctx));
    expect(out).toContain("לא נמצאו בעיות");
    expect(out).not.toContain("<section class=\"error\">");
  });

  it("has a fix for every category, and a specific one where the code has one", () => {
    for (const c of Object.keys(QA_CATEGORIES) as QaCategory[]) expect(suggestedFix("unknown/code", c)).toMatch(/\S/);
    expect(suggestedFix("sefaria/ref2-side")).toContain("ref_2");
    expect(categoryOf("export/reversed-dependency")).toBe("type");
    expect(categoryOf("export/anchor-on-notes-line")).toBe("anchor");
  });
});
