import type { AppStore } from "../../state/store";
import { useStore } from "../context";
import { pickFiles } from "../files";
import { Icon } from "../icons/icon";
import { FileName } from "../shell/file-name";
import { OtzariaDbHint, SOURCE_OPTIONS, type SourceOption } from "./add-sources";

/*
 * A reopened project's sources that are not open yet (audit F10). A browser cannot reopen a file by
 * itself, so the list names each source — the database file, the folder, the text files — with the
 * books its links wait for, and a button that opens the matching picker. It stays until every source
 * is back (the links then bind to the books by title) or the user hides it.
 */
const MAX_NAMES = 6;
type MissingSource = AppStore["missingSources"]["value"][number];

/** The picker that fits a saved source: a database, a ZIP, a folder (relative paths), or loose files. */
function pickerOf(s: MissingSource): SourceOption {
  const id: SourceOption["id"] = s.kind !== "text-files" ? "db" : /\.zip$/i.test(s.label) ? "zip" : s.files?.some((f) => f.includes("/")) ? "folder" : "files";
  return SOURCE_OPTIONS.find((o) => o.id === id)!;
}

const looksLikeFile = (name: string): boolean => /\.[A-Za-z0-9]{1,8}$/.test(name);

function names(list: readonly string[], file: boolean) {
  const shown = list.slice(0, MAX_NAMES);
  return (
    <>
      {shown.map((n, i) => (
        <span key={n}>
          {i > 0 && ", "}
          {file ? <FileName name={n.split("/").at(-1) ?? n} /> : <bdi>{n}</bdi>}
        </span>
      ))}
      {list.length > shown.length && ` ועוד ${(list.length - shown.length).toLocaleString("he")}`}
    </>
  );
}

export function ReopenSources() {
  const store = useStore();
  const missing = store.missingSources.value;
  if (!missing.length) return null;
  const reopen = async (s: MissingSource) => {
    const files = await pickFiles(pickerOf(s).pick);
    if (files.length) await store.openFiles(files);
  };
  return (
    <section class="reopen-sources" aria-label="מקורות לפתוח מחדש">
      <header>
        <Icon name="fl_history" size={18} />
        <b class="grow">מקורות לפתוח מחדש</b>
        <button class="icon-btn" onClick={() => store.dismissMissingSources()} title="הסתרת הרשימה. הקישורים שבפרויקט נשארים." aria-label="הסתרת רשימת המקורות לפתוח מחדש">
          <Icon name="fl_dismiss" size={16} />
        </button>
      </header>
      <p class="muted">הפרויקט נשמר בלי הספרים עצמם. בחרו שוב את המקורות האלה, והקישורים יחזרו למקומם בטקסט.</p>
      <ul>
        {missing.map((s, i) => {
          const o = pickerOf(s);
          return (
            <li key={i}>
              <Icon name={o.icon} size={16} />
              <div class="grow">
                <div class="name">{looksLikeFile(s.label) ? <FileName name={s.label} /> : <bdi>{s.label}</bdi>}</div>
                {s.files && s.files.length > 0 && o.id === "files" ? <div class="muted">הקבצים: {names(s.files, true)}</div> : null}
                {s.missingTitles.length > 0 && <div class="muted">ספרים שהקישורים מחכים להם: {names(s.missingTitles, false)}</div>}
              </div>
              <button class="btn tonal small" onClick={() => void reopen(s)} aria-label={`פתיחה מחדש: ${s.label}`} title={o.hint}>
                {o.label}…
              </button>
            </li>
          );
        })}
      </ul>
      {missing.some((s) => s.kind !== "text-files") && <OtzariaDbHint compact />}
    </section>
  );
}
