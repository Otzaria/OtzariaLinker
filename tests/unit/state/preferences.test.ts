import { describe, expect, it } from "vitest";
import { chooseLayout, fitLayoutToWidth, loadPreferences, PRESETS, resetLayout } from "../../../src/state/preferences";

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
