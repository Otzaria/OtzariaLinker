import { batch, effect, signal, type Signal } from "@preact/signals";

/*
 * User preferences and the workspace layout (ADR 0005). Kept in localStorage — a per-browser
 * convenience; every read and write is guarded because storage can be missing or blocked
 * (private windows, file:// policies). Nothing here is project data.
 */
export type ThemeSetting = "system" | "light" | "dark";
export type CreateMode = "builder" | "click";
export type SuggestionsView = "table" | "inline" | "card";

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
  advanced: Signal<boolean>;
  createMode: Signal<CreateMode>;
  suggestionsView: Signal<SuggestionsView>;
  layout: Signal<Layout>;
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

export function loadPreferences(storage: Storage | null = safeStorage()): Preferences {
  let saved: Partial<Record<keyof Preferences, unknown>> = {};
  try {
    saved = JSON.parse(storage?.getItem(KEY) ?? "{}") as typeof saved;
  } catch {
    /* corrupt or blocked — start from defaults */
  }
  const pick = <T>(v: unknown, ok: (x: unknown) => boolean, d: T): T => (ok(v) ? (v as T) : d);
  const prefs: Preferences = {
    theme: signal(pick(saved.theme, (x) => x === "system" || x === "light" || x === "dark", "system" as ThemeSetting)),
    fontScale: signal(pick(saved.fontScale, (x) => typeof x === "number" && x >= 0.7 && x <= 2, 1)),
    advanced: signal(pick(saved.advanced, (x) => typeof x === "boolean", false)),
    createMode: signal(pick(saved.createMode, (x) => x === "builder" || x === "click", "builder" as CreateMode)),
    suggestionsView: signal(pick(saved.suggestionsView, (x) => x === "table" || x === "inline" || x === "card", "table" as SuggestionsView)),
    // a narrow window starts on "two texts and a side panel" through fitLayoutToWidth, which keeps
    // this layout to return to when the window is made wide
    layout: signal(pick(saved.layout, isLayout, structuredClone(PRESETS.four))),
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
