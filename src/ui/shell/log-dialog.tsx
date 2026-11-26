import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LogEntry, LogLevel } from "../../diagnostics/log";
import { useStore } from "../context";
import { Icon } from "../icons/icon";

/*
 * The diagnostic log inside the tool (version 3's log drawer, F-137): what the tool reported, the long tasks with
 * their duration and outcome, worker restarts and errors. It updates while it is open, and it stays at the bottom
 * when the user is there. The log never holds book text (state/diagnostics.ts), so it is safe to show and to save.
 */
type Show = "all" | "problems" | "errors";
const SHOW_LABELS: Record<Show, string> = { all: "הכול", problems: "אזהרות ושגיאות", errors: "שגיאות בלבד" };
const LEVEL_LABELS: Record<LogLevel, string> = { debug: "פירוט", info: "מידע", warn: "אזהרה", error: "שגיאה" };
const shown = (show: Show, e: LogEntry): boolean => show === "all" || e.level === "error" || (show === "problems" && e.level === "warn");
const time = (t: number): string => new Date(t).toLocaleTimeString("he", { hour12: false });

export function LogDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState<Show>("all");
  const [, tick] = useState(0);
  // the bottom is followed only while the user is at it: reading an older entry is not interrupted
  const atBottom = useRef(true);
  useEffect(() => {
    ref.current?.showModal();
    return store.log.subscribe(() => tick((n) => n + 1));
  }, [store]);
  const entries = store.log.entries().filter((e) => shown(show, e));
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <dialog ref={ref} class="log-dialog" onClose={onClose} aria-labelledby="log-title">
      <div class="dlg">
        <header>
          <Icon name="oz_document_text" size={22} />
          <h2 id="log-title">יומן האבחון</h2>
          <span class="grow" />
          <button class="icon-btn" onClick={() => ref.current?.close()} aria-label="סגירה" title="סגירה (Esc)">
            <Icon name="fl_dismiss" />
          </button>
        </header>
        <div class="body">
          <p class="muted" style="margin:0">מה שהכלי דיווח בחלון הזה: הודעות, פעולות ארוכות ומשכן, ושגיאות. אין ביומן טקסט מהספרים, ולכן אפשר לצרף אותו לדיווח על תקלה.</p>
          <div class="filters" role="group" aria-label="מה להציג">
            {(Object.keys(SHOW_LABELS) as Show[]).map((s) => (
              <button key={s} class="chip" aria-pressed={show === s} onClick={() => ((atBottom.current = true), setShow(s))}>
                {SHOW_LABELS[s]}
              </button>
            ))}
          </div>
          <div
            ref={list}
            class="log-list"
            role="log"
            aria-label={`רשומות היומן (${entries.length.toLocaleString("he")})`}
            tabIndex={0}
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {entries.length === 0 ? (
              <p class="muted">{show === "all" ? "היומן ריק." : "אין רשומות כאלה. בחרו \"הכול\" כדי לראות את כל הרשומות."}</p>
            ) : (
              entries.map((e, i) => (
                <div key={`${e.t}-${i}`} class={`log-row ${e.level}`}>
                  <span class="t" dir="ltr">{time(e.t)}</span>
                  <span class="lv">{LEVEL_LABELS[e.level]}</span>
                  <span class="msg">
                    {e.msg}
                    <span class="area" dir="ltr"> {e.area}{e.code ? ` · ${e.code}` : ""}</span>
                    {e.data && <code class="data" dir="ltr">{JSON.stringify(e.data)}</code>}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <footer>
          <button class="btn outlined" onClick={() => store.saveDiagnostics()}>
            <Icon name="fl_arrow_download" size={18} />
            שמירה כקובץ (לצירוף לדיווח)
          </button>
          <button class="btn filled" onClick={() => ref.current?.close()}>סגירה</button>
        </footer>
      </div>
    </dialog>
  );
}
