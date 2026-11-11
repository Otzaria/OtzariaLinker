import { effect, signal, type Signal } from "@preact/signals";

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
}

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
    layout: signal(pick(saved.layout, isLayout, PRESETS.four)),
  };
  effect(() => {
    const snapshot = Object.fromEntries(Object.entries(prefs).map(([k, s]) => [k, (s as Signal<unknown>).value]));
    try {
      storage?.setItem(KEY, JSON.stringify(snapshot));
    } catch {
      /* storage full or blocked — preferences just won't persist */
    }
  });
  return prefs;
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
