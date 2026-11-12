import { PRESETS, type LayoutPreset, type PanelId, type ThemeSetting } from "../../state/preferences";
import { remainingText } from "../../state/task-progress";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { HistoryMenu } from "./history-menu";
import { Menu, MenuItem } from "./menu";

const PRESET_LABELS: Record<LayoutPreset, string> = { four: "ארבעה טורים", drawer: "שני טקסטים וחלונית צד", stack: "מקור מעל יעד" };
const PANEL_LABELS: Record<PanelId, string> = { sources: "מקורות וספרים", source: "ספר המקור", target: "ספר היעד", side: "החלונית (בונה, קישורים, הצעות)" };
const THEME_LABELS: Record<ThemeSetting, string> = { system: "לפי המערכת", light: "בהיר", dark: "כהה" };

export function AppBar({ onExport }: { onExport: () => void }) {
  const store = useStore();
  const { prefs } = store;
  const ls = store.linkState.value;
  const task = store.task.value;
  const eta = task ? remainingText(task.startedAt, task.done, task.total, Date.now()) : null;
  const inWorkspace = store.screen.value === "workspace";
  const count = [...ls.links.values()].filter((l) => l.status !== "deleted").length;

  return (
    <header class={`app-bar${inWorkspace ? " ws" : ""}`}>
      <button class="brand" onClick={() => (store.screen.value = "home")} title="למסך הפתיחה" aria-label="מנהל הקישורים — למסך הפתיחה">
        <Icon name="oz_links" size={24} />
        <span class="brand-name">מנהל הקישורים</span>
      </button>

      {inWorkspace && (
        <>
          <button class="icon-btn" disabled={!ls.undo.length} onClick={() => store.undo()} title={ls.undo.length ? `ביטול הפעולה האחרונה: ${ls.undo.at(-1)!.label} (Ctrl+Z)` : "אין מה לבטל"} aria-label="ביטול הפעולה האחרונה">
            <Icon name="fl_arrow_undo" />
          </button>
          <button class="icon-btn" disabled={!ls.redo.length} onClick={() => store.redo()} title={ls.redo.length ? `ביצוע חוזר: ${ls.redo.at(-1)!.label} (Ctrl+Y)` : "אין מה לבצע שוב"} aria-label="ביצוע חוזר">
            <Icon name="fl_arrow_redo" />
          </button>
          <HistoryMenu />
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
                {prefs.layout.value.hidden.length > 0 && <div class="label">פאנלים מוסתרים</div>}
                {prefs.layout.value.hidden.map((p) => (
                  <MenuItem key={p} icon="fl_add" onSelect={() => ((prefs.layout.value = { ...prefs.layout.value, hidden: prefs.layout.value.hidden.filter((x) => x !== p), order: prefs.layout.value.order.includes(p) ? prefs.layout.value.order : [...prefs.layout.value.order, p] }), close())}>
                    הצגת {PANEL_LABELS[p]}
                  </MenuItem>
                ))}
                <div class="label">גוררים כותרת של פאנל כדי להחליף מקומות, וגבול בין פאנלים כדי לשנות רוחב.</div>
              </>
            )}
          </Menu>
        </>
      )}

      {inWorkspace && store.guided.active.value && (
        <button class="btn tonal guided-back" onClick={() => store.guided.show()} title="חזרה לשלב שבו עצרתם בקישור התיקייה לאוצריא">
          <Icon name="oz_search_in_folder" size={16} />
          <span>חזרה להדרכה</span>
        </button>
      )}
      {task && (
        <div class="task" role="status">
          <span class="task-label" title={task.label}>{task.label}</span>
          {task.total > 0 && <progress max={task.total} value={task.done} />}
          {/* the task's own count and the time left, once an estimate means something (audit F21) */}
          {task.count && <span class="task-count">{task.count}</span>}
          {eta && <span class="task-eta">· {eta}</span>}
          <button class="btn text" onClick={task.cancel}>ביטול</button>
        </div>
      )}

      <span class="grow" />

      <label class="switch" title="מצב מתקדם: עריכת מחרוזת הסוג הגולמית, והגדרות השיטות האוטומטיות (ספי ודאות, סימני הערות ועוד)">
        <input type="checkbox" checked={prefs.advanced.value} onChange={(e) => (prefs.advanced.value = e.currentTarget.checked)} />
        <span>מצב מתקדם</span>
      </label>
      <span class="sep" />
      <button class="icon-btn" onClick={() => store.openHelp()} title="עזרה — מדריך למשתמש (F1)" aria-label="עזרה">
        <Icon name="fl_question_circle" />
      </button>
      <Menu icon="fl_settings" label="הגדרות">
        {(close) => (
          <>
            {/* on a phone the switch leaves the bar (one row); it lives here instead */}
            <MenuItem class="narrow-only" checked={prefs.advanced.value} onSelect={() => ((prefs.advanced.value = !prefs.advanced.value), close())}>
              מצב מתקדם
            </MenuItem>
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
            <MenuItem icon="fl_arrow_download" onSelect={() => (store.saveDiagnostics(), close())}>שמירת יומן אבחון (לצירוף לדיווח על תקלה)</MenuItem>
            <div class="label" dir="ltr" style="text-align:start">OtzariaLinker {__APP_VERSION__} · {__APP_COMMIT__}</div>
          </>
        )}
      </Menu>
      {inWorkspace && (
        <button class="icon-btn" onClick={() => store.saveProject()} title="שמירת הפרויקט כקובץ (Ctrl+S) — כדי להמשיך מאוחר יותר" aria-label="שמירת פרויקט">
          <Icon name="fl_save" />
        </button>
      )}
      {inWorkspace && (
        <button class="btn filled export" onClick={onExport} disabled={!count && !ls.undo.length} title="ייצוא קובצי ‎_links.json" aria-label={`ייצוא${count ? ` (${count.toLocaleString("he")})` : ""}`}>
          <Icon name="oz_link_download" size={18} />
          <span>
            <span class="lbl">ייצוא</span>
            {count ? ` (${count.toLocaleString("he")})` : ""}
          </span>
        </button>
      )}
    </header>
  );
}
