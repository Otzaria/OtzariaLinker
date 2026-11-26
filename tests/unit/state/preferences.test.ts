import { describe, expect, it } from "vitest";
import { chooseLayout, fitLayoutToWidth, loadPreferences, PRESETS, resetLayout, resetPreferences, effectiveLayout } from "../../../src/state/preferences";

/** A Storage in memory: what the preferences write is what the next session reads. */
function memory(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}
const saved = (s: Storage) => JSON.parse(s.getItem("otzaria-linker:prefs:v1")!).layout;

describe("the layout follows the window's width (V5 UX audit U14, owner's choice A)", () => {
  it("narrower than 1200: two texts and a side panel; wide again: the layout it replaced comes back", () => {
    const s = memory();
    const prefs = loadPreferences(s);
    expect(prefs.layout.value.preset).toBe("four");
    expect(fitLayoutToWidth(prefs, 1024)).toBe("narrowed");
    expect(prefs.layout.value).toEqual(PRESETS.drawer);
    // the automatic layout is never saved: the next (wide) session starts on four columns
    expect(saved(s).preset).toBe("four");
    expect(fitLayoutToWidth(prefs, 1100)).toBeNull();
    expect(fitLayoutToWidth(prefs, 1440)).toBe("restored");
    expect(prefs.layout.value.preset).toBe("four");
    expect(prefs.layoutAuto.value).toBeNull();
  });

  it("a layout the user chose in this session is never switched, and stays when the window widens", () => {
    const prefs = loadPreferences(memory());
    chooseLayout(prefs, structuredClone(PRESETS.stack));
    expect(fitLayoutToWidth(prefs, 900)).toBeNull();
    expect(prefs.layout.value.preset).toBe("stack");
    // a change made after an automatic switch makes the narrow layout the user's own
    const other = loadPreferences(memory());
    fitLayoutToWidth(other, 1000);
    chooseLayout(other, { ...other.layout.value, hidden: [] });
    expect(fitLayoutToWidth(other, 1600)).toBeNull();
    expect(other.layout.value.preset).toBe("drawer");
  });

  it("a layout saved in an earlier session is switched in a narrow window, and saved unchanged", () => {
    const s = memory({ "otzaria-linker:prefs:v1": JSON.stringify({ layout: { ...PRESETS.stack, sizes: { ...PRESETS.stack.sizes, side: 2 } } }) });
    const prefs = loadPreferences(s);
    fitLayoutToWidth(prefs, 1024);
    expect(prefs.layout.value.preset).toBe("drawer");
    expect(saved(s)).toMatchObject({ preset: "stack", sizes: { side: 2 } });
  });

  it("reset: every panel shown, the default for the width, automatic switching on again", () => {
    const prefs = loadPreferences(memory());
    chooseLayout(prefs, { ...PRESETS.four, hidden: ["sources", "side", "target"] });
    resetLayout(prefs, 1440);
    expect(prefs.layout.value).toEqual(PRESETS.four);
    expect(prefs.layoutChosen.value).toBe(false);
    resetLayout(prefs, 1024);
    expect(prefs.layout.value).toEqual(PRESETS.drawer);
    expect(fitLayoutToWidth(prefs, 1440)).toBe("restored");
    expect(prefs.layout.value).toEqual(PRESETS.four);
  });
});

describe("the side panel while the suggestions are reviewed (#41 B23)", () => {
  it("as wide as a reader in the suggestions tab, while its width is the preset's; other tabs and a width of the user's unchanged", () => {
    const four = structuredClone(PRESETS.four);
    // the side panel and the two readers share their width equally; the books list keeps its own
    const wide = effectiveLayout(four, "suggestions").sizes;
    expect(wide.sources).toBe(1);
    expect([wide.source, wide.target, wide.side].map((x) => +x.toFixed(4))).toEqual([1.8, 1.8, 1.8]);
    expect(effectiveLayout(four, "builder")).toBe(four);
    const mine = { ...four, sizes: { ...four.sizes, side: 1.1 } };
    expect(effectiveLayout(mine, "suggestions")).toBe(mine);
    const drawer = effectiveLayout(structuredClone(PRESETS.drawer), "suggestions").sizes;
    expect(drawer.side).toBeCloseTo(drawer.source);
    // "source above target": one reader column, as wide as the side panel
    const stack = effectiveLayout(structuredClone(PRESETS.stack), "suggestions").sizes;
    expect([stack.source, stack.side].map((x) => +x.toFixed(4))).toEqual([2.2, 2.2]);
    // never when a reader would be narrower than 380px: at 1280px four columns keep their widths, at 1366px they share
    expect(effectiveLayout(four, "suggestions", 1280)).toBe(four);
    expect(effectiveLayout(four, "suggestions", 1366).sizes.side).toBeCloseTo(1.8);
    const hidden = { ...four, hidden: ["side" as const] };
    expect(effectiveLayout(hidden, "suggestions")).toBe(hidden);
  });
});

describe("density, reset and the settings of version 3 (V7 parity F-133, F-131, F-129)", () => {
  it("density has four levels, starts on comfortable and is saved", () => {
    const s = memory();
    const prefs = loadPreferences(s);
    expect(prefs.density.value).toBe("comfortable");
    prefs.density.value = "dense";
    expect(JSON.parse(s.getItem("otzaria-linker:prefs:v1")!).density).toBe("dense");
    expect(loadPreferences(s).density.value).toBe("dense");
    // a value that is not a level is the default, not a broken page
    expect(loadPreferences(memory({ "otzaria-linker:prefs:v1": JSON.stringify({ density: "huge" }) })).density.value).toBe("comfortable");
  });

  it("reset: every setting back to its default and saved so; the layout too", () => {
    const s = memory();
    const prefs = loadPreferences(s);
    prefs.theme.value = "dark";
    prefs.fontScale.value = 1.4;
    prefs.density.value = "compact";
    prefs.advanced.value = true;
    prefs.createMode.value = "click";
    prefs.suggestionsView.value = "card";
    chooseLayout(prefs, structuredClone(PRESETS.stack));
    resetPreferences(prefs, 1440);
    expect(prefs.theme.value).toBe("system");
    expect(prefs.fontScale.value).toBe(1);
    expect(prefs.density.value).toBe("comfortable");
    expect(prefs.advanced.value).toBe(false);
    expect(prefs.createMode.value).toBe("builder");
    expect(prefs.suggestionsView.value).toBe("table");
    expect(prefs.layout.value).toEqual(PRESETS.four);
    expect(JSON.parse(s.getItem("otzaria-linker:prefs:v1")!)).toMatchObject({ theme: "system", density: "comfortable", advanced: false });
  });

  it("the settings of version 3 (otzaria-linker/settings/v2) are carried over once: theme, density, advanced", () => {
    const s = memory({ "otzaria-linker/settings/v2": JSON.stringify({ theme: "auto", density: "compact", advanced: true, linesPerChunk: 400 }) });
    const prefs = loadPreferences(s);
    expect(prefs.theme.value).toBe("system");
    expect(prefs.density.value).toBe("compact");
    expect(prefs.advanced.value).toBe(true);
    // saved under the new key; the old key is left as it was (version 3 may still be used in this browser)
    expect(JSON.parse(s.getItem("otzaria-linker:prefs:v1")!)).toMatchObject({ theme: "system", density: "compact", advanced: true });
    expect(s.getItem("otzaria-linker/settings/v2")).not.toBeNull();
    expect(loadPreferences(memory({ "otzaria-linker/settings/v2": JSON.stringify({ theme: "dark" }) })).theme.value).toBe("dark");
  });

  it("the old settings never override settings of this version, and a broken old value is ignored", () => {
    const prefs = loadPreferences(
      memory({
        "otzaria-linker/settings/v2": JSON.stringify({ theme: "dark", density: "dense" }),
        "otzaria-linker:prefs:v1": JSON.stringify({ theme: "light" }),
      }),
    );
    expect(prefs.theme.value).toBe("light");
    expect(prefs.density.value).toBe("comfortable");
    expect(loadPreferences(memory({ "otzaria-linker/settings/v2": "{not json" })).theme.value).toBe("system");
    const odd = loadPreferences(memory({ "otzaria-linker/settings/v2": JSON.stringify({ theme: 7, density: "x", advanced: "yes" }) }));
    expect([odd.theme.value, odd.density.value, odd.advanced.value]).toEqual(["system", "comfortable", false]);
  });
});
