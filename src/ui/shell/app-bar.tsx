import { useEffect, useState } from "preact/hooks";
import { chooseLayout, PRESETS, resetLayout, type Layout, type LayoutPreset, type PanelId, type ThemeSetting } from "../../state/preferences";
import type { RoleLabels } from "../../state/roles";
import { remainingText } from "../../state/task-progress";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { HistoryMenu } from "./history-menu";
import { Menu, MenuGroup, MenuItem } from "./menu";

const presetLabels = (r: RoleLabels): Record<LayoutPreset, string> => ({ four: "ארבעה טורים", drawer: "שני טקסטים וחלונית צד", stack: `${r.source.short} מעל ${r.target.short}` });
const panelLabels = (r: RoleLabels): Record<PanelId, string> => ({ sources: "קבצים, מסדים וספרים", source: r.source.name, target: r.target.name, side: "החלונית (בונה, קישורים, הצעות)" });
const THEME_LABELS: Record<ThemeSetting, string> = { system: "לפי המערכת", light: "בהיר", dark: "כהה" };

export function AppBar({ onExport }: { onExport: () => void }) {
  const store = useStore();
  const { prefs } = store;
  const ls = store.linkState.value;
  const task = store.task.value;
  const eta = task ? remainingText(task.startedAt, task.done, task.total, Date.now()) : null;
  const inWorkspace = store.screen.value === "workspace";
  const count = [...ls.links.values()].filter((l) => l.status !== "deleted").length;
  const layout = prefs.layout.value;
  const hidden = layout.hidden;

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
          <Menu icon="fl_layout_column_four" label="פריסת סביבת העבודה" badge={hidden.length} badgeLabel={hidden.length === 1 ? "פאנל אחד מוסתר" : `${hidden.length.toLocaleString("he")} פאנלים מוסתרים`}>
            {(close) => (
              <>
                <MenuGroup label="תבניות פריסה">
                  {(Object.keys(PRESETS) as LayoutPreset[]).map((p) => (
                    <MenuItem key={p} checked={layout.preset === p} onSelect={() => (chooseLayout(prefs, structuredClone(PRESETS[p])), close())}>
                      {presetLabels(store.roles.value)[p]}
                    </MenuItem>
                  ))}
                </MenuGroup>
                {hidden.length > 0 && (
                  <MenuGroup label="פאנלים מוסתרים">
                    {hidden.map((p) => (
                      <MenuItem key={p} icon="fl_add" onSelect={() => (chooseLayout(prefs, showPanel(layout, p)), close())}>
                        הצגת {panelLabels(store.roles.value)[p]}
                      </MenuItem>
                    ))}
                  </MenuGroup>
                )}
                <MenuItem icon="fl_arrow_undo" onSelect={() => (resetLayout(prefs, innerWidth), (store.missingSourcesFolded.value = false), close())}>
                  איפוס הפריסה (כל הפאנלים מוצגים)
                </MenuItem>
                <div class="label">גוררים כותרת של פאנל כדי להחליף מקומות, וגבול בין פאנלים כדי לשנות רוחב.{prefs.layoutAuto.value ? " החלון צר, ולכן הפריסה עברה לבד ל\"שני טקסטים וחלונית צד\"; בחלון רחב הקודמת חוזרת." : ""}</div>
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
      <TaskAnnouncer />
      {/* the guided run step shows the task's one bar itself (V5 UX audit U16): not a second one here */}
      {task && !(store.screen.value === "guided" && store.guided.step.value === "run") && (
        <div class="task">
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
            <MenuGroup label="ערכת צבעים">
              {(["system", "light", "dark"] as ThemeSetting[]).map((t) => (
                <MenuItem key={t} icon={t === "dark" ? "fl_weather_moon" : "fl_weather_sunny"} checked={prefs.theme.value === t} onSelect={() => ((prefs.theme.value = t), close())}>
                  {THEME_LABELS[t]}
                </MenuItem>
              ))}
            </MenuGroup>
            <MenuGroup label="גודל טקסט הספרים">
              {/* the size is part of each button's name: the screen reader says it after every press */}
              <div style="display:flex;gap:6px;padding:4px 10px;align-items:center">
                <button class="btn outlined" role="menuitem" tabIndex={-1} onClick={() => (prefs.fontScale.value = Math.max(0.7, +(prefs.fontScale.value - 0.1).toFixed(2)))} aria-label={`הקטנה (עכשיו ${Math.round(prefs.fontScale.value * 100)}%)`}>א−</button>
                <span class="grow" style="text-align:center" aria-hidden="true">{Math.round(prefs.fontScale.value * 100)}%</span>
                <button class="btn outlined" role="menuitem" tabIndex={-1} onClick={() => (prefs.fontScale.value = Math.min(2, +(prefs.fontScale.value + 0.1).toFixed(2)))} aria-label={`הגדלה (עכשיו ${Math.round(prefs.fontScale.value * 100)}%)`}>א+</button>
              </div>
            </MenuGroup>
            <MenuGroup label="יצירת קישור">
              <MenuItem checked={prefs.createMode.value === "builder"} onSelect={() => ((prefs.createMode.value = "builder"), close())}>בונה עם כפתור יצירה</MenuItem>
              <MenuItem checked={prefs.createMode.value === "click"} onSelect={() => ((prefs.createMode.value = "click"), close())}>לחיצה ולחיצה (יוצר מיד)</MenuItem>
            </MenuGroup>
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

/** A hidden panel shown again: back in its place; in "source above target" the target shares the source's column. */
function showPanel(layout: Layout, p: PanelId): Layout {
  const hidden = layout.hidden.filter((x) => x !== p);
  const inline = layout.preset === "stack" && p === "target";
  return { ...layout, hidden, order: inline || layout.order.includes(p) ? layout.order : [...layout.order, p] };
}

/**
 * What a screen reader hears about the running task (WCAG 4.1.3): its name when it starts, then every
 * quarter of the way. A live region that is always on the page — one that appears together with its
 * text is often not read at all — and not the progress bar itself, which would be read at every step.
 * Rendered once in the app bar, and again inside a modal dialog that runs a task (the page behind a
 * modal is inert, and its live regions with it).
 */
export function TaskAnnouncer() {
  const store = useStore();
  const task = store.task.value;
  const quarter = task && task.total > 0 ? Math.min(3, Math.floor((task.done / task.total) * 4)) : 0;
  const [text, setText] = useState("");
  useEffect(() => setText(!task ? "" : quarter > 0 ? `${task.label}: ${quarter * 25}%` : task.label), [task?.label, quarter, !task]);
  return (
    <div class="sr-only" role="status" data-live="task">
      {text}
    </div>
  );
}
