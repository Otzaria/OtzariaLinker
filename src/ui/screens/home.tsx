import { useEffect, useRef, useState } from "preact/hooks";
import type { EngineId } from "../../linking/automatic";
import type { SuggestMode } from "../../state/router";
import type { SideTab } from "../../state/store";
import { useStore } from "../context";
import { fromDataTransfer, pickFiles } from "../files";
import { Icon, type IconName } from "../icons/icon";
import { OtzariaDbHint, SOURCE_OPTIONS, type SourceOption } from "../workspace/add-sources";
import { SourceBadge } from "../workspace/source-badge";
import { ltr } from "../shell/file-name";

/*
 * Home (ADR 0005 §1): the plan's eight guided workflows, with a drop strip at the side. A workflow
 * opens a short sheet ("#/start/<id>") that asks for each source it needs — the folder, then the
 * Otzaria database; a personal database; the old and the new edition — shows what was opened, and
 * starts the workspace where the work happens (the engine, max-link on the right source, the links
 * tab, the relink dialog). Every workflow ends in the same workspace.
 */
type OptionId = SourceOption["id"];
interface Step {
  label: string;
  hint: string;
  options: OptionId[];
  optional?: boolean;
  /** say where the Otzaria database is */
  dbHint?: boolean;
}
interface TaskDef {
  id: string;
  icon: IconName;
  title: string;
  hint: string;
  steps: Step[];
  then: {
    tab: SideTab;
    engine?: EngineId;
    mode?: SuggestMode;
    dialog?: "relink";
    /** the step whose source max-link or a batch should run on */
    scopeStep?: number;
  };
}

export const TASKS: readonly TaskDef[] = [
  {
    id: "commentary",
    icon: "oz_book_link",
    title: "ספר ופירוש",
    hint: "פירוש מול ספר הבסיס שלו — לפי כותרות ודיבור המתחיל",
    steps: [
      { label: "הפירוש", hint: `קובץ ${ltr(".txt")}, תיקייה או מסד שבו הפירוש. אם גם ספר הבסיס שם — זה מספיק.`, options: ["files", "folder", "db"] },
      { label: "ספר הבסיס, אם הוא במקור אחר", hint: "בדרך כלל מסד אוצריא.", options: ["db", "files"], optional: true, dbHint: true },
    ],
    then: { tab: "suggestions", engine: "headings", mode: "pair" },
  },
  {
    id: "notes",
    icon: "oz_link_marker",
    title: "ספר והערות שוליים",
    hint: "מספרי ההערות בספר מול ספר ההערות",
    steps: [
      { label: "ספר ההערות", hint: "ואם אפשר גם הספר עצמו, באותה בחירה.", options: ["files", "folder", "db"] },
      { label: "הספר שעליו ההערות, אם הוא במקור אחר", hint: "קובץ, תיקייה או מסד.", options: ["files", "db"], optional: true, dbHint: true },
    ],
    then: { tab: "suggestions", engine: "footnotes", mode: "pair" },
  },
  {
    id: "folder-otzaria",
    icon: "oz_search_in_folder",
    title: "תיקייה מול אוצריא",
    hint: "כל הספרים שבתיקייה מקושרים לספרים שבמסד אוצריא — כל שיטה שמתאימה לכל ספר",
    steps: [
      { label: "התיקייה", hint: `פירושים, ספרי הערות וספרים חדשים (${ltr(".txt")}).`, options: ["folder", "zip", "files"] },
      { label: "מסד אוצריא", hint: "seforim.db — הספרים שהתיקייה מקשרת אליהם.", options: ["db"], dbHint: true },
    ],
    then: { tab: "suggestions", mode: "maxlink", scopeStep: 0 },
  },
  {
    id: "db-db",
    icon: "oz_library_link",
    title: "מסד מול מסד",
    hint: "מסד אישי מול מסד אוצריא, או שני מסדים כלשהם",
    steps: [
      { label: "המסד שממנו מקשרים", hint: "למשל מסד אישי. מסד במבנה אחר נפתח דרך אשף מיפוי.", options: ["db"] },
      { label: "המסד שאליו מקשרים", hint: "למשל מסד אוצריא.", options: ["db"], dbHint: true },
    ],
    then: { tab: "suggestions", mode: "maxlink", scopeStep: 0 },
  },
  {
    id: "within-db",
    icon: "oz_book_links",
    title: "קישור בתוך מסד אישי",
    hint: "פירושים וספרי הערות שבמסד, כל אחד מול הספר שעליו נכתב באותו מסד",
    steps: [{ label: "המסד האישי", hint: "קובץ SQLite של ספרייה אישית או מצורפת.", options: ["db"] }],
    then: { tab: "suggestions", mode: "maxlink", scopeStep: 0 },
  },
  {
    id: "edit-links",
    icon: "oz_link_edit",
    title: "עריכת קישורים קיימים",
    hint: `קובצי ${ltr("_links.json")} — בדיקה, תיקון וייצוא מחדש`,
    steps: [
      { label: "קובצי הקישורים", hint: `${ltr("_links.json")}, ZIP, תיקייה או גיליון CSV.`, options: ["files", "zip", "folder"] },
      { label: "הספרים שהקישורים מצביעים אליהם", hint: "כדי לראות ולבדוק אותם מול הטקסט: מסד אוצריא או התיקייה.", options: ["db", "folder", "files"], optional: true, dbHint: true },
    ],
    then: { tab: "links" },
  },
  {
    id: "relink",
    icon: "oz_text_compare",
    title: "תיקון קישורים אחרי שינוי ספר",
    hint: "המהדורה הישנה, החדשה וקובץ הקישורים — הקישורים עוברים לשורות הנכונות",
    steps: [
      { label: "המהדורה הישנה וקובץ הקישורים שלה", hint: `בחרו את שניהם יחד (הספר ${ltr(".txt")} וה־${ltr("_links.json")}).`, options: ["files", "folder"] },
      { label: "המהדורה החדשה", hint: "אותו ספר אחרי השינוי: קובץ, תיקייה או מסד.", options: ["files", "folder", "db"] },
    ],
    then: { tab: "links", dialog: "relink" },
  },
  {
    id: "manual",
    icon: "oz_link_add",
    title: "עבודה ידנית מתקדמת",
    hint: "בוחרים ספרים, שורות, טווחים ומילים בעצמכם — גם בין מקורות שונים",
    steps: [
      { label: "מקור ראשון", hint: "תיקייה, קבצים, מסד או ZIP.", options: ["folder", "files", "db", "zip"] },
      { label: "מקור נוסף", hint: "למשל מסד אוצריא, כדי לקשר אליו.", options: ["db", "folder", "files"], optional: true, dbHint: true },
    ],
    then: { tab: "builder" },
  },
];

const OPTION = new Map(SOURCE_OPTIONS.map((o) => [o.id, o]));

export function Home() {
  const store = useStore();
  const [over, setOver] = useState(false);
  const pick = async (o: SourceOption) => {
    const files = await pickFiles(o.pick);
    if (files.length) await store.openFiles(files);
  };
  const begin = (t: TaskDef) => {
    store.startTask.value = t.id;
    store.dialog.value = "start";
  };
  const hasWork = store.sources.value.length > 0 || store.linkState.value.links.size > 0;

  return (
    <main class="home">
      <section>
        {store.recovery.value && (
          <div class="recovery" role="alert">
            <Icon name="fl_history" size={24} />
            <span class="grow">נמצאה עבודה שלא נשמרה מהפעם הקודמת: {store.recovery.value.links.toLocaleString("he")} קישורים.</span>
            <button class="btn filled" onClick={store.recovery.value.restore}>שחזור</button>
            <button class="btn text" onClick={store.recovery.value.dismiss}>התעלמות</button>
          </div>
        )}
        <h1>מה תרצו לעשות?</h1>
        <p class="lede">בוחרים משימה, והכלי יבקש רק את מה שצריך. הכול נשאר במחשב שלכם — שום קובץ לא נשלח לשום מקום.</p>
        <div class="tasks">
          {TASKS.map((t) => (
            <button key={t.id} class="task-card" onClick={() => begin(t)}>
              <Icon name={t.icon} size={28} />
              <b>{t.title}</b>
              <span>{t.hint}</span>
            </button>
          ))}
        </div>
        {hasWork && (
          <div class="recent">
            <button class="btn tonal" onClick={() => (store.screen.value = "workspace")}>
              <Icon name="oz_book_open_medium_lines" size={18} />
              חזרה לסביבת העבודה ({store.sources.value.length} מקורות, {store.linkState.value.links.size.toLocaleString("he")} קישורים)
            </button>
          </div>
        )}
      </section>

      <aside
        class={`drop-strip${over ? " over" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          if (e.dataTransfer) await store.openFiles(await fromDataTransfer(e.dataTransfer));
        }}
      >
        <Icon name="fl_arrow_upload" size={36} />
        <b>גררו לכאן ספרים, תיקייה, מסד או קובץ קישורים</b>
        <span class="muted">הכלי מזהה לבד את סוג כל קובץ. אפשר לפתוח כמה מקורות יחד ולקשר ביניהם.</span>
        <div class="actions">
          {SOURCE_OPTIONS.map((o) => (
            <button key={o.id} class="btn outlined" onClick={() => void pick(o)} title={o.hint}>
              <Icon name={o.icon} size={16} />
              {o.label}
            </button>
          ))}
        </div>
        <OtzariaDbHint />
        <p class="privacy">
          <Icon name="fl_info" size={16} />
          <span>מסדי נתונים נפתחים לקריאה בלבד. הכלי לעולם לא משנה את הקבצים שלכם — כל תוצר נשמר כקובץ חדש.</span>
        </p>
      </aside>
    </main>
  );
}

/** The sheet of a guided workflow ("#/start/<id>"): one row per source it needs, then "start". */
export function StartTaskDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const task = TASKS.find((t) => t.id === store.startTask.value);
  /** per step: the ids of the sources it opened, or true when it opened only documents (links files, a project) */
  const [done, setDone] = useState<Record<number, string[] | true>>({});
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  // an unknown task in the address: nothing to show
  useEffect(() => {
    if (!task) onClose();
  }, [task]);
  if (!task) return null;

  const open = async (i: number, o: SourceOption) => {
    const files = await pickFiles(o.pick);
    if (!files.length) return;
    const before = new Set(store.sources.peek().map((s) => s.info.id));
    const links = store.linkState.peek().links.size;
    const pending = store.pendingDbs.peek().length;
    await store.openFiles(files);
    const added = store.sources.peek().filter((s) => !before.has(s.info.id)).map((s) => s.info.id);
    if (added.length) setDone((d) => ({ ...d, [i]: [...(Array.isArray(d[i]) ? (d[i] as string[]) : []), ...added] }));
    else if (store.linkState.peek().links.size !== links || store.pendingDbs.peek().length > pending) setDone((d) => ({ ...d, [i]: d[i] ?? true }));
  };
  const ready = task.steps.every((s, i) => s.optional || done[i]);
  const start = () => {
    const then = task.then;
    const scoped = then.scopeStep !== undefined ? done[then.scopeStep] : undefined;
    const sourceId = Array.isArray(scoped) ? scoped[0] : undefined;
    store.intent.value = { ...(then.engine && { engine: then.engine }), ...(sourceId && { sourceId }) };
    if (then.mode) store.suggestMode.value = then.mode;
    store.sideTab.value = then.tab;
    store.screen.value = "workspace";
    // the relink dialog takes the sheet's place in the address; otherwise the sheet closes into the workspace
    if (then.dialog) store.dialog.value = then.dialog;
    else ref.current?.close();
  };
  const sourcesOf = (i: number) => {
    const d = done[i];
    return Array.isArray(d) ? store.sources.value.filter((s) => d.includes(s.info.id)) : [];
  };

  return (
    <dialog ref={ref} class="start-task" onClose={onClose} aria-labelledby="start-title">
      <div class="dlg">
        <header>
          <Icon name={task.icon} size={24} />
          <h2 id="start-title">{task.title}</h2>
          <span class="grow" />
          <button class="icon-btn" onClick={() => ref.current?.close()} aria-label="סגירה" title="סגירה (Esc)">
            <Icon name="fl_dismiss" />
          </button>
        </header>
        <div class="body">
          <p class="muted" style="margin:0">{task.hint}. בחרו את מה שצריך, שלב אחרי שלב; כל מקור מתווסף לאלה שכבר פתוחים.</p>
          <ol class="steps">
            {task.steps.map((s, i) => (
              <li key={i} class={done[i] ? "done" : undefined}>
                <span class="num" aria-hidden="true">{done[i] ? <Icon name="oz_check" size={16} /> : i + 1}</span>
                <div class="grow">
                  <b>{s.label}</b>
                  {s.optional && <span class="muted"> (לא חובה)</span>}
                  <div class="muted">{s.hint}</div>
                  <div class="row">
                    {s.options.map((id) => {
                      const o = OPTION.get(id)!;
                      return (
                        <button key={id} class="btn outlined" onClick={() => void open(i, o)} title={o.hint} aria-label={`${s.label}: ${o.label}`}>
                          <Icon name={o.icon} size={16} />
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                  {sourcesOf(i).map((src) => (
                    <div key={src.info.id} class="opened">
                      <Icon name="fl_checkmark_circle" size={14} />
                      <SourceBadge source={src} name /> · {src.books.length.toLocaleString("he")} ספרים
                    </div>
                  ))}
                  {done[i] === true && <div class="opened"><Icon name="fl_checkmark_circle" size={14} /> נטען</div>}
                  {s.dbHint && <OtzariaDbHint compact />}
                </div>
              </li>
            ))}
          </ol>
        </div>
        <footer>
          <button class="btn text" onClick={() => ref.current?.close()}>ביטול</button>
          <button class="btn filled" disabled={!ready} onClick={start} title={ready ? undefined : "חסר מקור שהמשימה צריכה"}>
            <Icon name="oz_link" size={18} />
            התחלה
          </button>
        </footer>
      </div>
    </dialog>
  );
}
