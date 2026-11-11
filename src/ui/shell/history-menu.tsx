import { historyPosition, timeline } from "../../state/history";
import { useStore } from "../context";
import { Menu } from "./menu";
import "./history-menu.css";

/*
 * The history list (v3 "היסטוריית פעולות", Ctrl+H there), next to undo and redo in the app bar:
 * every action of the project, newest first, with its time. The current point is marked; actions
 * after it were undone and can be redone. Choosing an entry undoes or redoes up to it — the same
 * steps as pressing undo/redo that many times, so nothing is lost by moving around.
 */
const time = (at: number) => new Date(at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function HistoryMenu() {
  const store = useStore();
  const s = store.linkState.value;
  const entries = timeline(s).reverse();
  const at = historyPosition(s);
  return (
    <div class="history-menu">
      <Menu icon="fl_history" label="היסטוריית פעולות">
        {(close) => (
          <div class="history-list">
            <div class="label">היסטוריית פעולות — בחרו נקודה כדי לחזור אליה</div>
            {!entries.length && <div class="history-empty">עדיין לא בוצעו פעולות. כל יצירה, עריכה, ייבוא ומחיקה של קישורים נרשמת כאן, ואפשר לחזור לכל נקודה.</div>}
            {entries.map((e) => {
              const current = e.position === at;
              return (
                <button
                  key={e.position}
                  class={`item${e.applied ? "" : " undone"}`}
                  role="menuitemradio"
                  aria-checked={current}
                  title={current ? "המצב הנוכחי" : e.applied ? "ביטול הפעולות שאחרי זו" : "ביצוע חוזר עד לפעולה זו"}
                  onClick={() => (store.goToHistory(e.position), close())}
                >
                  <span class="grow">
                    <span class="history-label">{e.label}</span>
                    <span class="history-meta">
                      {time(e.at)}
                      {!e.applied && " · בוטלה"}
                      {current && " · המצב הנוכחי"}
                    </span>
                  </span>
                </button>
              );
            })}
            {entries.length > 0 && (
              <button class={`item${at === 0 ? "" : " start"}`} role="menuitemradio" aria-checked={at === 0} onClick={() => (store.goToHistory(0), close())}>
                <span class="grow">
                  <span class="history-label">לפני כל הפעולות שברשימה</span>
                  <span class="history-meta">ביטול של כולן{at === 0 && " · המצב הנוכחי"}</span>
                </span>
              </button>
            )}
          </div>
        )}
      </Menu>
    </div>
  );
}
