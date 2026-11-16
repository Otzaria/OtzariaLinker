import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";

/*
 * What makes a screenshot the same on every Windows machine (docs/TESTING.md §2a).
 *
 * The book fonts are embedded in the app, but the UI font is the system's: "Segoe UI" first, "Cascadia
 * Mono" or Consolas for numbers and paths, and those differ between Windows builds (and are missing on a
 * server image). Here every system family the app's CSS names is shadowed by embedded fonts, through
 * @font-face rules added before the page's own scripts (a web font of the same name wins over an
 * installed one): Assistant (OFL, tests/visual/fonts/) for the text, and the app's own Frank Ruhl CLM for
 * the cantillation marks Assistant lacks (book lines quoted in the UI font). Nothing in src/ changes;
 * the shots show the app's layout, colours and text in Assistant instead of Segoe UI.
 *
 * Symbols neither font has (▾ ◂ ← → ✓ ✕ …) still come from Windows' core fonts (Segoe UI Symbol,
 * Cambria Math, Arial), which every Windows has. `fontLeaks` asks Chrome (DevTools
 * CSS.getPlatformFontsForNode) which fonts drew each element's text, and reports an element where a
 * system font drew more glyphs than the element has such symbols: Hebrew or Latin text in a font that
 * differs on the next machine fails the run instead of slipping through.
 */
const b64 = (path: string) => readFileSync(resolve(path)).toString("base64");
const ASSISTANT = b64("tests/visual/fonts/Assistant-Variable.woff2");
const FRANK = b64("src/ui/theme/fonts/FrankRuehlCLM-Medium.ttf");

/** Every family name in the app's CSS that resolves to an installed font on some machine. */
const SHADOWED = ["Segoe UI", "Roboto", "Helvetica Neue", "Arial", "Noto Sans Hebrew", "Cascadia Mono", "Consolas", "Menlo", "Frank Ruhl Libre", "David", "Noto Serif Hebrew", "Georgia"];

// the last rule is tried first: Assistant; a Hebrew cluster it cannot draw whole (a letter with a
// cantillation mark) goes to Frank Ruhl, whose range holds the letters too, not only the marks
const FONT_CSS = SHADOWED.map(
  (family) =>
    `@font-face{font-family:"${family}";src:url(data:font/ttf;base64,${FRANK}) format("truetype");font-weight:200 800;unicode-range:U+0591-05F4}` +
    `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${ASSISTANT}) format("woff2");font-weight:200 800}`,
).join("");

/** Characters the embedded fonts draw: Latin-1, Hebrew with its points and marks, general punctuation. */
const EMBEDDED = /[\u0000-\u00ff\u0590-\u05ff\u2000-\u206f\u20aa\ufb1d-\ufb4f\s]/gu;

export async function embedFonts(page: Page) {
  await page.addInitScript((css: string) => {
    const add = () => {
      const style = document.createElement("style");
      style.dataset.visual = "fonts";
      style.textContent = css;
      document.documentElement.prepend(style);
    };
    if (document.documentElement) add();
    else document.addEventListener("readystatechange", add, { once: true });
  }, FONT_CSS);
}

/** Waits until every font face the page declared and uses has loaded. */
export async function fontsSettled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if ([...document.fonts].some((f) => f.status === "loading")) await document.fonts.ready;
  });
}

export type FontLeak = { family: string; glyphs: number; symbols: number; text: string };

/** Elements whose Hebrew or Latin text was drawn by a system font (see above). */
export async function fontLeaks(page: Page): Promise<FontLeak[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    type Node = { nodeId: number; nodeType: number; nodeName: string; nodeValue?: string; children?: Node[]; shadowRoots?: Node[] };
    // Chrome counts the glyphs of an element together with its inline children (a <kbd>, a <b>): the
    // symbols are counted in the whole subtree
    const withText: { id: number; text: string; all: string }[] = [];
    const walk = (n: Node): string => {
      const own = (n.children ?? []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue ?? "").join("");
      const all = [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(walk).join("");
      if (n.nodeType === 1 && own.trim() && !/^(SCRIPT|STYLE|TITLE)$/.test(n.nodeName)) withText.push({ id: n.nodeId, text: own.trim(), all });
      return n.nodeType === 3 ? (n.nodeValue ?? "") : all;
    };
    walk(root as Node);
    const leaks: FontLeak[] = [];
    // all requests at once: one round trip each, one after the other, took seconds on a full screen
    const used = await Promise.all(withText.map(({ id }) => cdp.send("CSS.getPlatformFontsForNode", { nodeId: id })));
    for (const [i, { text, all }] of withText.entries()) {
      const { fonts } = used[i]!;
      const symbols = [...all.replace(EMBEDDED, "")].length;
      for (const f of fonts) if (!f.isCustomFont && f.glyphCount > symbols) leaks.push({ family: f.familyName, glyphs: f.glyphCount, symbols, text: text.slice(0, 60) });
    }
    return leaks;
  } finally {
    await cdp.detach();
  }
}
