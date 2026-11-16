import { expect, type Locator, type Page } from "@playwright/test";

/*
 * Accessibility checks written for this app, without axe (no new dependency): the names come from
 * Playwright's own accessible-name computation (ARIA snapshots), the rest from the rendered page.
 * Used by tests/e2e/accessibility.spec.ts; docs/reviews/ACCESSIBILITY_AUDIT.md says what each guards.
 */

/** Roles a user operates; one of them without a name is announced as just "button", "edit"… */
const OPERABLE = "button|link|textbox|searchbox|checkbox|radio|combobox|listbox|tab|menuitem|menuitemradio|menuitemcheckbox|switch|slider|spinbutton|separator|option|treeitem";
const UNNAMED = new RegExp(`^\\s*- (${OPERABLE})(?: \\[[^\\]]*\\])*:?\\s*$`);

/**
 * The operable elements under `root` that have no accessible name, as their ARIA-snapshot lines with
 * the two lines above them (where on the screen they are). Empty = every control is named.
 */
export async function unnamedControls(root: Locator): Promise<string[]> {
  const lines = (await root.ariaSnapshot()).split("\n");
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (UNNAMED.test(l)) out.push(lines.slice(Math.max(0, i - 2), i + 1).map((x) => x.trim()).join(" ⟩ "));
  });
  return out;
}

/** The element that has focus, described: tag, role, its name (aria-label or text) and whether a focus indicator is drawn. */
export interface Focused {
  tag: string;
  role: string | null;
  name: string;
  indicator: boolean;
  inDialog: boolean;
  inViewport: boolean;
}

export async function focused(page: Page): Promise<Focused | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    const shadow = cs.boxShadow !== "none";
    const label = el.getAttribute("aria-label") ?? (el.getAttribute("aria-labelledby") ? document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent : null);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      name: (label ?? el.innerText ?? (el as HTMLInputElement).value ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      indicator: outline || shadow,
      inDialog: !!el.closest("dialog[open]"),
      inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
    };
  });
}

/**
 * Presses Tab (or Shift+Tab) until the focused element's name matches, as a keyboard-only user would.
 * Fails after `max` presses. Every stop on the way must show a focus indicator.
 */
export async function tabTo(page: Page, name: RegExp, { max = 80, back = false }: { max?: number; back?: boolean } = {}): Promise<Focused> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    const f = await focused(page);
    if (!f) continue;
    seen.push(f.name);
    expect(f.indicator, `no visible focus on <${f.tag}> "${f.name}"`).toBe(true);
    if (name.test(f.name)) return f;
  }
  throw new Error(`Tab never reached ${name}; stops: ${seen.join(" | ")}`);
}

/** Interactive elements smaller than 24×24 CSS px (WCAG 2.5.8), excluding links inside running text. */
export async function smallTargets(root: Locator): Promise<string[]> {
  return root.evaluate((r) => {
    const sel = "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=radio], [role=checkbox], [role=menuitem], [role=menuitemradio], [tabindex]:not([tabindex='-1'])";
    const out: string[] = [];
    for (const el of r.querySelectorAll<HTMLElement>(sel)) {
      if (el.closest("[inert], [aria-hidden=true]") || el.classList.contains("sr-only")) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue; // not rendered
      if (el.tagName === "A" && el.closest("p, li, td") && getComputedStyle(el).display === "inline") continue;
      // a checkbox inside its label: the label is the target
      const target = el.tagName === "INPUT" && el.closest("label") ? el.closest("label")!.getBoundingClientRect() : b;
      if (target.width < 24 || target.height < 24) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(target.width)}×${Math.round(target.height)}`);
    }
    return [...new Set(out)];
  });
}

/**
 * Text whose colour against its painted background is below WCAG AA (4.5:1, or 3:1 for large text).
 * Background = the nearest painted ancestors composited; opacity of ancestors fades the text toward it.
 * Disabled controls are exempt (WCAG 1.4.3), and so is text over an image or a gradient (not measured).
 */
export async function lowContrast(root: Locator): Promise<string[]> {
  return root.evaluate((r) => {
    type RGBA = [number, number, number, number];
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const parse = (c: string): RGBA => {
      // any CSS colour (color(srgb …), oklab(…) from color-mix) → sRGB through a canvas pixel
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = "#000";
      probe.fillStyle = c;
      probe.fillRect(0, 0, 1, 1);
      const [R, G, B, A] = probe.getImageData(0, 0, 1, 1).data;
      return [R!, G!, B!, A! / 255];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (!a) return [0, 0, 0, 0];
      return [0, 1, 2].map((i) => (top[i]! * top[3] + under[i]! * under[3] * (1 - top[3])) / a).concat(a) as RGBA;
    };
    const lum = ([R, G, B]: RGBA) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(R) + 0.7152 * f(G) + 0.0722 * f(B);
    };
    const ratio = (a: RGBA, b: RGBA) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    const backdrop = (el: Element): RGBA | null => {
      const layers: RGBA[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage !== "none") return null;
        const c = parse(cs.backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let bg: RGBA = parse(getComputedStyle(document.body).backgroundColor);
      for (const l of layers.reverse()) bg = over(l, bg);
      return bg;
    };
    const fade = (el: Element) => {
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      return o;
    };
    const out = new Map<string, string>();
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent?.trim()) continue;
      const el = t.parentElement!;
      if (el.closest(".sr-only, [aria-hidden=true], option, :disabled, [aria-disabled=true], .btn:disabled")) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || getComputedStyle(el).visibility === "hidden") continue;
      const bg = backdrop(el);
      if (!bg) continue;
      const cs = getComputedStyle(el);
      let fg = parse(cs.color);
      fg = over([fg[0], fg[1], fg[2], fg[3] * fade(el)], bg);
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const got = ratio(fg, bg);
      if (got < need) {
        const where = `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}`;
        const key = `${where} ${cs.color} on ${bg.slice(0, 3).map(Math.round).join(",")}`;
        if (!out.has(key)) out.set(key, `${got.toFixed(2)}:1 (need ${need}) ${where} "${t.textContent.trim().slice(0, 24)}" fg=${cs.color} bg=rgb(${bg.slice(0, 3).map(Math.round).join(",")})`);
      }
    }
    return [...out.values()];
  });
}

/**
 * Controls the user cannot reach at the current viewport: outside the window horizontally (no page
 * scroll here, body is overflow:hidden) or vertically, with no scrollable ancestor that brings them in.
 */
export async function clippedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel = "button, a[href], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex='-1'])";
    const out: string[] = [];
    const scrolls = (n: Element, axis: "x" | "y") => {
      const cs = getComputedStyle(n);
      const o = axis === "x" ? cs.overflowX : cs.overflowY;
      return (o === "auto" || o === "scroll") && (axis === "x" ? n.scrollWidth > n.clientWidth : n.scrollHeight > n.clientHeight);
    };
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (el.closest("[inert], [aria-hidden=true], .sr-only, dialog:not([open])")) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const outX = b.right > innerWidth + 1 || b.left < -1;
      const outY = b.bottom > innerHeight + 1 || b.top < -1;
      if (!outX && !outY) continue;
      let reachable = false;
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) if ((outX && scrolls(n, "x")) || (outY && scrolls(n, "y"))) reachable = true;
      if (!reachable) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" at ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    return out;
  });
}

/** Whether the document scrolls sideways at the current viewport. */
export const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
