import { batch, effect, signal, type Signal } from "@preact/signals";
import type { MarkerBasis } from "../linking/ranges";

/*
 * User preferences and the workspace layout (ADR 0005). Kept in localStorage — a per-browser
 * convenience; every read and write is guarded because storage can be missing or blocked
 * (private windows, file:// policies). Nothing here is project data.
 */
export type ThemeSetting = "system" | "light" | "dark";
export type CreateMode = "builder" | "click";
export type SuggestionsView = "table" | "inline" | "card";
/** Version 3's four densities (F-133): the padding, size and spacing of the book lines (tokens.css [data-density]). */
export type Density = "spacious" | "comfortable" | "compact" | "dense";
export const DENSITIES: readonly Density[] = ["spacious", "comfortable", "compact", "dense"];

export type PanelId = "sources" | "source" | "target" | "side";
export type LayoutPreset = "four" | "drawer" | "stack";

export interface Layout {
  preset: LayoutPreset;
  /** column order, first = rightmost in RTL */
  order: PanelId[];
  /** relative widths (fr) */
  sizes: Record<PanelId, number>;
  hidden: PanelId[];
}

export const PRESETS: Record<LayoutPreset, Layout> = {
  four: { preset: "four", order: ["sources", "source", "target", "side"], sizes: { sources: 1, source: 2, target: 2, side: 1.4 }, hidden: [] },
  drawer: { preset: "drawer", order: ["source", "target", "side"], sizes: { sources: 1, source: 2, target: 2, side: 1.3 }, hidden: ["sources"] },
  stack: { preset: "stack", order: ["sources", "source", "side"], sizes: { sources: 1, source: 3, target: 3, side: 1.4 }, hidden: [] },
};

export interface Preferences {
  theme: Signal<ThemeSetting>;
  fontScale: Signal<number>;
  density: Signal<Density>;
  advanced: Signal<boolean>;
  createMode: Signal<CreateMode>;
  suggestionsView: Signal<SuggestionsView>;
  layout: Signal<Layout>;
  /** v3's rangeEndBasis (F-079): where the builder's "until the next" stops — a link or a heading, a link, a heading, the book's end */
  rangeEndBasis: Signal<MarkerBasis>;
  /** v3's rangeAutoEnd (F-055), per side: a new pick on that side runs by itself until the line before the next marker */
  rangeAutoEnd: Signal<{ source: boolean; target: boolean }>;
  /** v3's rangeTrimPrevious (F-083): a new link cuts the range of an earlier link it falls inside (same undo step) */
  rangeTrimPrevious: Signal<boolean>;
  /**
   * Session only, never saved: the user chose a preset or changed the layout (hid or showed a panel,
   * moved a border or a panel) in this session. Until then a window narrower than NARROW_WIDTH gets the
   * preset "two texts and a side panel" by itself (fitLayoutToWidth).
   */
  layoutChosen: Signal<boolean>;
  /** Session only: the layout the automatic switch replaced; it comes back when the window is wide again. */
  layoutAuto: Signal<Layout | null>;
}

/** Below this width four columns are too tight (V5 UX audit U14): names of one letter, a table that scrolls sideways. */
export const NARROW_WIDTH = 1200;

const KEY = "otzaria-linker:prefs:v1";
/** Version 3's one settings key (F-129). Read once, when this version has no settings of its own yet; never written. */
export const LEGACY_KEY = "otzaria-linker/settings/v2";

const DEFAULTS = { theme: "system" as ThemeSetting, fontScale: 1, density: "comfortable" as Density, advanced: false, createMode: "builder" as CreateMode, suggestionsView: "table" as SuggestionsView, rangeEndBasis: "auto" as MarkerBasis, rangeTrimPrevious: true };
/** a fresh object each time: a shared one would be the same value in every session that changes it */
const defaultAutoEnd = (): { source: boolean; target: boolean } => ({ source: false, target: false });

/**
 * The settings of version 3 that still mean something here: the theme ("auto" was "system"), the density and the
 * advanced mode. Its other 13 settings have no counterpart (they were removed or became choices on the screen
 * that uses them, V7_LEGACY_PARITY §4.4), so they are not carried over.
 */
function legacySettings(storage: Storage | null): Record<string, unknown> {
  let old: Record<string, unknown>;
  try {
    old = JSON.parse(storage?.getItem(LEGACY_KEY) ?? "null") as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!old || typeof old !== "object") return {};
  const out: Record<string, unknown> = {};
  if (old.theme === "auto") out.theme = "system";
  else if (old.theme === "light" || old.theme === "dark") out.theme = old.theme;
  if (DENSITIES.includes(old.density as Density)) out.density = old.density;
  if (typeof old.advanced === "boolean") out.advanced = old.advanced;
  return out;
}

export function loadPreferences(storage: Storage | null = safeStorage()): Preferences {
  let saved: Partial<Record<keyof Preferences, unknown>> = {};
  try {
    const own = storage?.getItem(KEY);
    // the first run of this version in a browser that ran version 3 starts on its settings (F-129)
    saved = (own == null ? legacySettings(storage) : JSON.parse(own)) as typeof saved;
  } catch {
    /* corrupt or blocked — start from defaults */
  }
  const pick = <T>(v: unknown, ok: (x: unknown) => boolean, d: T): T => (ok(v) ? (v as T) : d);
  const prefs: Preferences = {
    theme: signal(pick(saved.theme, (x) => x === "system" || x === "light" || x === "dark", DEFAULTS.theme)),
    fontScale: signal(pick(saved.fontScale, (x) => typeof x === "number" && x >= 0.7 && x <= 2, DEFAULTS.fontScale)),
    density: signal(pick(saved.density, (x) => DENSITIES.includes(x as Density), DEFAULTS.density)),
    advanced: signal(pick(saved.advanced, (x) => typeof x === "boolean", DEFAULTS.advanced)),
    createMode: signal(pick(saved.createMode, (x) => x === "builder" || x === "click", DEFAULTS.createMode)),
    suggestionsView: signal(pick(saved.suggestionsView, (x) => x === "table" || x === "inline" || x === "card", DEFAULTS.suggestionsView)),
    // a narrow window starts on "two texts and a side panel" through fitLayoutToWidth, which keeps
    // this layout to return to when the window is made wide
    layout: signal(pick(saved.layout, isLayout, structuredClone(PRESETS.four))),
    rangeEndBasis: signal(pick(saved.rangeEndBasis, (x) => x === "auto" || x === "links" || x === "headings" || x === "book", DEFAULTS.rangeEndBasis)),
    rangeAutoEnd: signal(pick(saved.rangeAutoEnd, isSides, defaultAutoEnd())),
    rangeTrimPrevious: signal(pick(saved.rangeTrimPrevious, (x) => typeof x === "boolean", DEFAULTS.rangeTrimPrevious)),
    layoutChosen: signal(false),
    layoutAuto: signal(null),
  };
  fitLayoutToWidth(prefs, globalThis.innerWidth ?? 1920);
  effect(() => {
    const { layoutChosen: _c, layoutAuto: auto, ...kept } = prefs;
    // the automatic layout is never saved: a wider window next time starts on the user's own layout
    const snapshot = Object.fromEntries(Object.entries(kept).map(([k, s]) => [k, k === "layout" ? (auto.value ?? s.value) : (s as Signal<unknown>).value]));
    try {
      storage?.setItem(KEY, JSON.stringify(snapshot));
    } catch {
      /* storage full or blocked — preferences just won't persist */
    }
  });
  return prefs;
}

/** A layout change the user made (a preset, a hidden or shown panel, a border, a swap): no more automatic switching this session. */
export function chooseLayout(prefs: Preferences, next: Layout): void {
  batch(() => {
    prefs.layout.value = next;
    prefs.layoutChosen.value = true;
    prefs.layoutAuto.value = null;
  });
}

/**
 * The window became narrower or wider (V5 UX audit U14, the owner's choice A). Narrower than
 * NARROW_WIDTH, and the user has not chosen a layout in this session: the preset "two texts and a side
 * panel" (the books move to the side panel's "ספרים" tab); the layout it replaced is kept. Wide again:
 * that layout comes back — but only while the automatic one is untouched (any change of the user's
 * makes the current layout theirs, chooseLayout). Returns what happened.
 */
export function fitLayoutToWidth(prefs: Preferences, width: number): "narrowed" | "restored" | null {
  const auto = prefs.layoutAuto.peek();
  if (width >= NARROW_WIDTH) {
    if (!auto) return null;
    batch(() => {
      prefs.layout.value = auto;
      prefs.layoutAuto.value = null;
    });
    return "restored";
  }
  if (auto || prefs.layoutChosen.peek() || prefs.layout.peek().preset === "drawer") return null;
  batch(() => {
    prefs.layoutAuto.value = prefs.layout.peek();
    prefs.layout.value = structuredClone(PRESETS.drawer);
  });
  return "narrowed";
}

/** "איפוס הפריסה": the default layout for this window, every panel shown, automatic switching on again. */
export function resetLayout(prefs: Preferences, width: number): void {
  batch(() => {
    prefs.layout.value = structuredClone(PRESETS.four);
    prefs.layoutChosen.value = false;
    prefs.layoutAuto.value = null;
    fitLayoutToWidth(prefs, width);
  });
}

/**
 * The side panel's width while the suggestions are reviewed (#41 B23): the table of suggestions holds both lines of each
 * suggestion, and at 1366px its share of a four-column layout (1.4 of 6.4) left the texts cut to a few words. While
 * the "הצעות" tab is shown and the user has not set the side panel's width themselves (it is the preset's), the side
 * panel is as wide as a reader: the readers' width and its own are shared equally (at 1366px about 80px more), and the
 * books list keeps its width. A border dragged or moved in that tab keeps the widths shown, and from then on they are
 * the user's own. Only while a reader keeps MIN_READER_PX (from about 1366px in four columns).
 */
export const MIN_READER_PX = 380;
export function effectiveLayout(layout: Layout, sideTab: string, width = Infinity): Layout {
  if (sideTab !== "suggestions" || layout.hidden.includes("side") || layout.sizes.side !== PRESETS[layout.preset].sizes.side) return layout;
  // the readers that have a column of their own ("source above target" puts the target in the source's column)
  const readers = (["source", "target"] as const).filter((p) => layout.order.includes(p) && !layout.hidden.includes(p));
  const pool = readers.reduce((n, p) => n + layout.sizes[p], layout.sizes.side);
  const each = pool / (readers.length + 1);
  if (each <= layout.sizes.side) return layout;
  // never at the readers' expense below MIN_READER_PX: at 1280px a reader's title row wrapped
  const shown = layout.order.filter((p) => !layout.hidden.includes(p)).reduce((n, p) => n + layout.sizes[p], 0);
  if (readers.length && (width * each) / shown < MIN_READER_PX) return layout;
  const sizes = { ...layout.sizes, side: each };
  for (const p of readers) sizes[p] = each;
  return { ...layout, sizes };
}

/** "איפוס ההגדרות" (version 3's "איפוס לברירות המחדל", F-131): every setting and the layout back to their defaults. */
export function resetPreferences(prefs: Preferences, width: number): void {
  batch(() => {
    prefs.theme.value = DEFAULTS.theme;
    prefs.fontScale.value = DEFAULTS.fontScale;
    prefs.density.value = DEFAULTS.density;
    prefs.advanced.value = DEFAULTS.advanced;
    prefs.createMode.value = DEFAULTS.createMode;
    prefs.suggestionsView.value = DEFAULTS.suggestionsView;
    prefs.rangeEndBasis.value = DEFAULTS.rangeEndBasis;
    prefs.rangeAutoEnd.value = defaultAutoEnd();
    prefs.rangeTrimPrevious.value = DEFAULTS.rangeTrimPrevious;
    resetLayout(prefs, width);
  });
}

/** A panel one place towards the start (-1) or the end (+1), swapped with its nearest SHOWN neighbour; at an edge the same layout. */
export function movePanel(layout: Layout, id: PanelId, delta: -1 | 1): Layout {
  const shown = layout.order.filter((p) => p === id || !layout.hidden.includes(p));
  const other = shown[shown.indexOf(id) + delta];
  if (!shown.includes(id) || !other) return layout;
  const order = layout.order.map((p) => (p === id ? other : p === other ? id : p));
  return { ...layout, order };
}

function isSides(x: unknown): boolean {
  const s = x as { source: unknown; target: unknown } | null;
  return !!s && typeof s === "object" && typeof s.source === "boolean" && typeof s.target === "boolean";
}

const PANELS: readonly PanelId[] = ["sources", "source", "target", "side"];
function isLayout(x: unknown): boolean {
  const l = x as Layout;
  return (
    !!l && (l.preset === "four" || l.preset === "drawer" || l.preset === "stack") &&
    Array.isArray(l.order) && l.order.every((p) => PANELS.includes(p)) && new Set(l.order).size === l.order.length &&
    !!l.sizes && PANELS.every((p) => typeof l.sizes[p] === "number" && l.sizes[p] > 0) &&
    Array.isArray(l.hidden) && l.hidden.every((p) => PANELS.includes(p))
  );
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
