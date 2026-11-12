import { useState } from "preact/hooks";
import { useStore } from "../context";
import { fromDataTransfer, pickFiles } from "../files";
import { Icon, type IconName } from "../icons/icon";
import { ltr } from "../shell/file-name";

/*
 * Adding a source is first-class: a folder, files, a database (the Otzaria one or a personal one),
 * a ZIP or a saved project, each through its own picker — and a visible drop target. Every source
 * opened is added to the ones already open, so books of different sources can be linked: a folder
 * against the Otzaria database, a personal database against it, two folders, or inside one database.
 */
export interface SourceOption {
  id: "folder" | "files" | "db" | "zip" | "project";
  icon: IconName;
  label: string;
  hint: string;
  pick: { folder?: boolean; accept?: string };
}

export const SOURCE_OPTIONS: readonly SourceOption[] = [
  { id: "folder", icon: "fl_folder_open", label: "תיקייה", hint: `כל הספרים (${ltr(".txt")}) וקובצי הקישורים שבה ובתתי־התיקיות`, pick: { folder: true } },
  { id: "files", icon: "fl_add", label: "קבצים", hint: "ספרים, קובצי קישורים, גיליונות — כמה שרוצים", pick: {} },
  { id: "db", icon: "fl_database", label: "מסד נתונים", hint: "מסד אוצריא (seforim.db) או מסד אישי", pick: { accept: ".db,.sqlite,.sqlite3" } },
  { id: "zip", icon: "fl_folder", label: "ZIP", hint: "ארכיון של ספרים וקובצי קישורים", pick: { accept: ".zip" } },
  { id: "project", icon: "oz_document_link", label: "פרויקט שמור", hint: `קובץ ${ltr(".otzlinker.json")} שנשמר קודם`, pick: { accept: ".json" } },
];

/** Where Otzaria keeps its database on Windows (the installer's default). */
export const OTZARIA_DB_PATH = "C:\\ProgramData\\otzaria\\books\\seforim.db";

/** The browser cannot open a path by itself: where the Otzaria database is, and how to pick it. */
export function OtzariaDbHint({ compact }: { compact?: boolean }) {
  const store = useStore();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(OTZARIA_DB_PATH);
      store.notify("success", "הנתיב הועתק. בחלון הבחירה הדביקו אותו בשדה \"שם הקובץ\" ולחצו \"פתח\".");
    } catch {
      store.notify("info", `לא הצלחתי להעתיק. הנתיב: ${OTZARIA_DB_PATH}`);
    }
  };
  return (
    <div class={`db-hint${compact ? " compact" : ""}`}>
      <Icon name="fl_info" size={16} />
      <div>
        <b>איפה מסד אוצריא?</b> בדרך כלל:
        {/* a break opportunity after each backslash: a narrow column wraps the path between folders, not inside a name */}
        <bdi dir="ltr" class="path">
          {OTZARIA_DB_PATH.split("\\").map((part, i, all) => (
            <span key={i}>
              {part}
              {i < all.length - 1 && (
                <>
                  \<wbr />
                </>
              )}
            </span>
          ))}
        </bdi>
        <button class="btn text small" onClick={copy} title="העתקת הנתיב, כדי להדביק אותו בחלון הבחירה">
          <Icon name="fl_copy" size={14} />
          העתקה
        </button>
        {!compact && (
          <div class="muted">
            הדפדפן לא פותח נתיב בעצמו: לחצו "מסד נתונים", הדביקו את הנתיב בשדה "שם הקובץ" ולחצו "פתח". התיקייה ProgramData מוסתרת בסייר הקבצים, אבל הדבקת הנתיב עובדת.
          </div>
        )}
      </div>
    </div>
  );
}

/** "Add a source": the options, the database hint, and a drop zone — in the workspace's sources panel. */
export function AddSources({ startOpen }: { startOpen?: boolean }) {
  const store = useStore();
  const [open, setOpen] = useState(!!startOpen);
  const [over, setOver] = useState(false);
  const add = async (o: SourceOption) => {
    const files = await pickFiles(o.pick);
    if (files.length) await store.openFiles(files);
  };
  return (
    <div class="add-sources">
      <button class="btn outlined add-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="fl_add" size={16} />
        <span class="grow" style="text-align:start">הוספת מקור</span>
        <Icon name="fl_chevron_down" size={14} class={open ? "flip" : undefined} />
      </button>
      {open && (
        <div class="add-options" role="group" aria-label="סוג המקור להוספה">
          {SOURCE_OPTIONS.map((o) => (
            <button key={o.id} class="add-option" onClick={() => void add(o)} title={o.hint} aria-label={o.label}>
              <Icon name={o.icon} size={18} />
              <span class="grow">
                <b>{o.label}</b>
                <span class="muted">{o.hint}</span>
              </span>
            </button>
          ))}
          <OtzariaDbHint compact />
        </div>
      )}
      <div
        class={`drop-zone${over ? " over" : ""}`}
        onDragOver={(e) => e.dataTransfer?.types.includes("Files") && (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          if (!e.dataTransfer?.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          await store.openFiles(await fromDataTransfer(e.dataTransfer));
        }}
      >
        <Icon name="fl_arrow_upload" size={18} />
        <span>גררו לכאן עוד תיקייה, קבצים או מסד</span>
      </div>
    </div>
  );
}
