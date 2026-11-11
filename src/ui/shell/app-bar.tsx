import { PRESETS, type LayoutPreset, type ThemeSetting } from "../../state/preferences";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { Menu, MenuItem } from "./menu";

const PRESET_LABELS: Record<LayoutPreset, string> = { four: "ארבעה טורים", drawer: "שני טקסטים וחלונית צד", stack: "מקור מעל יעד" };
const THEME_LABELS: Record<ThemeSetting, string> = { system: "לפי המערכת", light: "בהיר", dark: "כהה" };

export function AppBar({ onExport }: { onExport: () => void }) {
  const store = useStore();
  const { prefs } = store;
  const ls = store.linkState.value;
  const task = store.task.value;
  const inWorkspace = store.screen.value === "workspace";
  const count = [...ls.links.values()].filter((l) => l.status !== "deleted").length;

  return (
    <header class="app-bar">
      <button class="brand" onClick={() => (store.screen.value = "home")} title="למסך הפתיחה">
        <Icon name="oz_links" size={24} />
        <span>מנהל הקישורים</span>
      </button>

      {inWorkspace && (
        <>
          <button class="icon-btn" disabled={!ls.undo.length} onClick={() => store.undo()} title={ls.undo.length ? `ביטול: ${ls.undo.at(-1)!.label} (Ctrl+Z)` : "אין מה לבטל"} aria-label="ביטול">
            <Icon name="fl_arrow_undo" />
          </button>
          <button class="icon-btn" disabled={!ls.redo.length} onClick={() => store.redo()} title={ls.redo.length ? `ביצוע חוזר: ${ls.redo.at(-1)!.label} (Ctrl+Y)` : "אין מה לבצע שוב"} aria-label="ביצוע חוזר">
            <Icon name="fl_arrow_redo" />
          </button>
          <span class="sep" />
          <Menu icon="fl_layout_column_four" label="פריסת סביבת העבודה">
            {(close) => (
              <>
                <div class="label">תבניות פריסה</div>
                {(Object.keys(PRESETS) as LayoutPreset[]).map((p) => (
                  <MenuItem key={p} checked={prefs.layout.value.preset === p} onSelect={() => ((prefs.layout.value = structuredClone(PRESETS[p])), close())}>
                    {PRESET_LABELS[p]}
                  </MenuItem>
                ))}
                <div class="label">גוררים כותרת של פאנל כדי להחליף מקומות, וגבול בין פאנלים כדי לשנות רוחב.</div>
              </>
            )}
          </Menu>
        </>
      )}

      {task && (
        <div class="task" role="status">
          <span>{task.label}</span>
          {task.total > 0 && <progress max={task.total} value={task.done} />}
          <button class="btn text" onClick={task.cancel}>ביטול</button>
        </div>
      )}

      <span class="grow" />

      <label class="switch" title="מצב מתקדם: ספים, נרמול, שדות ספריא, מיפוי שדות ועוד">
        <input type="checkbox" checked={prefs.advanced.value} onChange={(e) => (prefs.advanced.value = e.currentTarget.checked)} />
        <span>מצב מתקדם</span>
      </label>
      <span class="sep" />
      <Menu icon="fl_settings" label="הגדרות">
        {(close) => (
          <>
            <div class="label">ערכת צבעים</div>
            {(["system", "light", "dark"] as ThemeSetting[]).map((t) => (
              <MenuItem key={t} icon={t === "dark" ? "fl_weather_moon" : "fl_weather_sunny"} checked={prefs.theme.value === t} onSelect={() => ((prefs.theme.value = t), close())}>
                {THEME_LABELS[t]}
              </MenuItem>
            ))}
            <div class="label">גודל טקסט הספרים</div>
            <div style="display:flex;gap:6px;padding:4px 10px;align-items:center">
              <button class="btn outlined" onClick={() => (prefs.fontScale.value = Math.max(0.7, +(prefs.fontScale.value - 0.1).toFixed(2)))} aria-label="הקטנה">א−</button>
              <span class="grow" style="text-align:center">{Math.round(prefs.fontScale.value * 100)}%</span>
              <button class="btn outlined" onClick={() => (prefs.fontScale.value = Math.min(2, +(prefs.fontScale.value + 0.1).toFixed(2)))} aria-label="הגדלה">א+</button>
            </div>
            <div class="label">יצירת קישור</div>
            <MenuItem checked={prefs.createMode.value === "builder"} onSelect={() => ((prefs.createMode.value = "builder"), close())}>בונה עם כפתור יצירה</MenuItem>
            <MenuItem checked={prefs.createMode.value === "click"} onSelect={() => ((prefs.createMode.value = "click"), close())}>לחיצה ולחיצה (יוצר מיד)</MenuItem>
          </>
        )}
      </Menu>
      {inWorkspace && (
        <button class="icon-btn" onClick={() => store.saveProject()} title="שמירת הפרויקט כקובץ (Ctrl+S) — כדי להמשיך מאוחר יותר" aria-label="שמירת פרויקט">
          <Icon name="fl_save" />
        </button>
      )}
      {inWorkspace && (
        <button class="btn filled" onClick={onExport} disabled={!count && !ls.undo.length} title="ייצוא קובצי ‎_links.json">
          <Icon name="oz_link_download" size={18} />
          ייצוא{count ? ` (${count.toLocaleString("he")})` : ""}
        </button>
      )}
    </header>
  );
}
