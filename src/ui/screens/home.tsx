import { useEffect, useRef, useState } from "preact/hooks";
import type { EngineId } from "../../linking/automatic";
import type { SuggestMode } from "../../state/router";
import { GUIDED_STEP_TITLES } from "../../state/guided-flow";
import { HOME_CARDS, isPathId, pathOfTask, TASK_PATHS, type PathId } from "../../state/task-paths";
import type { SideTab } from "../../state/store";
import { useStore } from "../context";
import { fromDataTransfer, pickFiles } from "../files";
import { rovingKeys, rovingTabIndex } from "../keyboard";
import { Icon, type IconName } from "../icons/icon";
import { OfflineDownload } from "../shell/offline-download";
import { OtzariaDbHint, SOURCE_OPTIONS, type SourceOption } from "../workspace/add-sources";
import { SourceBadge } from "../workspace/source-badge";
import { assignOpenSources, candidatesFor, type OpenSource } from "./task-sources";
import { ltr } from "../shell/file-name";

/*
 * Home (ADR 0005 §1): the plan's eight guided workflows and two the product audit asked for (F15:
 * several books together, links already in a database), with a drop strip at the side. A workflow
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
    /** max-link over every open book (several books together) */
    allBooks?: boolean;
    /** the links tab opens on the database's own links */
    dbLinks?: boolean;
  };
  /**
   * The card starts the guided flow (state/guided-flow.ts, "#/guided") instead of the sheet. The sheet
   * stays at "#/start/<id>" (the old path), linked from the flow's first step.
   */
  guided?: boolean;
}

export const TASKS: readonly TaskDef[] = [
  {
    id: "commentary",
    icon: "oz_book_link",
    title: "ספר ופירוש",
    // "one": with four commentaries on one tractate, three cards looked right (V5 UX audit, task b)
    hint: `פירוש אחד מול ספר הבסיס שלו — לפי כותרות ודיבור המתחיל (לכמה פירושים יחד: "כמה ספרים יחד")`,
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
      // the engine's roles (automatic/index.ts): the SOURCE is the book with the note numbers, the TARGET the notes book
      { label: "הספר עם מספרי ההערות", hint: "הספר עצמו, שבטקסט שלו מופיעים מספרי ההערות. ואם ספר ההערות באותו מקור, באותה בחירה.", options: ["files", "folder", "db"] },
      { label: "ספר ההערות, אם הוא במקור אחר", hint: "קובץ, תיקייה או מסד. השורות בו נפתחות במספר ההערה.", options: ["files", "db"], optional: true, dbHint: true },
    ],
    then: { tab: "suggestions", engine: "footnotes", mode: "pair" },
  },
  {
    // reachable from the "automatic linking" path (issue 20); the citations method links one book into all the open ones
    id: "citations",
    icon: "oz_link_marker",
    title: "מראי מקומות",
    hint: "הפניות כתובות בטקסט ('בראשית א, ב', 'ב\"ק דף ט') מקושרות לספרים שהן מציינות",
    steps: [
      { label: "הספר עם מראי המקום", hint: `קובץ ${ltr(".txt")}, תיקייה או מסד.`, options: ["files", "folder", "db"] },
      { label: "הספרים שמצטטים אליהם, אם הם במקור אחר", hint: "בדרך כלל מסד אוצריא.", options: ["db", "folder", "files"], optional: true, dbHint: true },
    ],
    then: { tab: "suggestions", engine: "citations", mode: "pair" },
  },
  {
    // audit F15: several books that link to each other, with no fixed roles — max-link over all of them
    id: "several",
    icon: "oz_links",
    title: "כמה ספרים יחד",
    hint: "כמה פירושים, ספרי הערות וספרי בסיס — הכלי מזהה מי קשור למי ומקשר את כולם",
    steps: [
      { label: "הספרים", hint: `קבצים (${ltr(".txt")}), תיקייה, ZIP או מסד — אפשר כמה יחד.`, options: ["files", "folder", "zip", "db"] },
      { label: "ספרי הבסיס, אם הם במקור אחר", hint: "למשל מסד אוצריא, כשהפירושים מתייחסים לספרים שבו.", options: ["db", "folder", "files"], optional: true, dbHint: true },
    ],
    then: { tab: "suggestions", mode: "maxlink", allBooks: true },
    guided: true,
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
    guided: true,
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
    // audit F15: the links a database already has, without a links file
    id: "db-links",
    icon: "oz_search_in_links",
    title: "הקישורים שכבר במסד",
    hint: "מה שמסד אוצריא או מסד אישי כבר מקשר לכל ספר — לקריאה, לבדיקה ולהעתקה לפרויקט",
    steps: [{ label: "המסד", hint: "מסד אוצריא (seforim.db) או מסד אישי. בוחרים ספר בקורא, והקישורים שלו מוצגים.", options: ["db"], dbHint: true }],
    then: { tab: "links", dbLinks: true },
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
    title: "קישור ידני",
    hint: "בוחרים ספרים, שורות, טווחים ומילים בעצמכם — גם בין מקורות שונים",
    steps: [
      { label: "מקור ראשון", hint: "תיקייה, קבצים, מסד או ZIP.", options: ["folder", "files", "db", "zip"] },
      { label: "מקור נוסף", hint: "למשל מסד אוצריא, כדי לקשר אליו.", options: ["db", "folder", "files"], optional: true, dbHint: true },
    ],
    then: { tab: "builder" },
  },
];

const OPTION = new Map(SOURCE_OPTIONS.map((o) => [o.id, o]));

/*
 * The five paths of the home screen (issue 20). "auto", "repo" and "fix" open a sheet that first asks which task
 * (state/task-paths.ts says which tasks each one chooses from); "manual" is a task of its own; "project" opens a saved
 * project file. The tasks above and their routes #/start/<id> are unchanged.
 */
const PATHS: Record<PathId, { icon: IconName; title: string; hint: string; ask: string }> = {
  auto: {
    icon: "oz_book_link",
    title: "קישור אוטומטי",
    hint: "הכלי מוצא את הקישורים לבד: פירוש, הערות שוליים, מראי מקומות, כמה ספרים יחד או תיקייה שלמה מול אוצריא",
    ask: "מה לקשר?",
  },
  repo: {
    icon: "oz_library_link",
    title: "ניתוח והשלמת קישורים במאגר",
    hint: "מה שמסד אוצריא או מסד אישי כבר מקשר, והשלמת מה שחסר — מסד מול מסד, בתוך מסד, או הקישורים הקיימים",
    ask: "מה לעשות במאגר?",
  },
  fix: {
    icon: "oz_link_edit",
    title: "בדיקה, תיקון ומיזוג קישורים",
    hint: `קובצי ${ltr("_links.json")} קיימים: בדיקה, תיקון, השוואה ומיזוג, ומעבר למהדורה חדשה של ספר`,
    ask: "מה לתקן?",
  },
};
const PROJECT_CARD = { icon: "oz_document_link" as IconName, title: "פתיחת פרויקט קיים", hint: `קובץ ${ltr(".otzlinker.json")} שנשמר קודם — ממשיכים מאיפה שעצרתם` };

export function Home() {
  const store = useStore();
  const [over, setOver] = useState(false);
  const pick = async (o: SourceOption) => {
    const files = await pickFiles(o.pick);
    if (files.length) await store.openFiles(files);
  };
  const begin = (t: TaskDef) => {
    if (t.guided) return store.guided.start();
    store.startTask.value = t.id;
    store.dialog.value = "start";
  };
  const openPath = (id: PathId) => {
    store.startTask.value = id;
    store.dialog.value = "start";
  };
  const openProject = () => void pick(OPTION.get("project")!);
  const hasWork = store.sources.value.length > 0 || store.linkState.value.links.size > 0;

  return (
    <main class="home">
      <section>
        {/* an unfinished guided flow brings its links back itself ("המשך"): one card, not two */}
        {store.recovery.value && !(store.guided.saved.value && !store.guided.active.value) && (
          <div class="recovery" role="alert">
            <Icon name="fl_history" size={24} />
            <span class="grow">נמצאה עבודה שלא נשמרה מהפעם הקודמת: {store.recovery.value.links.toLocaleString("he")} קישורים.</span>
            <button class="btn filled" onClick={store.recovery.value.restore}>שחזור</button>
            <button class="btn text" onClick={store.recovery.value.dismiss}>התעלמות</button>
          </div>
        )}
        {store.guided.saved.value && !store.guided.active.value && (
          <div class="recovery" role="alert">
            <Icon name="oz_search_in_folder" size={24} />
            <span class="grow">
              קישור תיקייה לאוצריא לא הסתיים: הגעתם לשלב "{GUIDED_STEP_TITLES[store.guided.saved.value.step]}" עם {store.guided.saved.value.sources.map((s) => `"${s.label}"`).join(", ")}.
            </span>
            <button class="btn filled" onClick={() => store.guided.continueSaved()}>המשך</button>
            <button class="btn text" onClick={() => store.guided.dismissSaved()}>לא עכשיו</button>
          </div>
        )}
        <h1>מה תרצו לעשות?</h1>
        <p class="lede">בוחרים משימה, והכלי יבקש רק את מה שצריך. הכול נשאר במחשב שלכם — שום קובץ לא נשלח לשום מקום.</p>
        <div class="tasks">
          {HOME_CARDS.map((id) => {
            const manual = id === "manual" ? TASKS.find((t) => t.id === "manual")! : undefined;
            const card = id === "project" ? PROJECT_CARD : (manual ?? PATHS[id as PathId]);
            const onClick = id === "project" ? openProject : manual ? () => begin(manual) : () => openPath(id as PathId);
            return (
              <button key={id} class="task-card" data-path={id} onClick={onClick}>
                <Icon name={card.icon} size={28} />
                <b>{card.title}</b>
                <span>{card.hint}</span>
              </button>
            );
          })}
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
        <OfflineDownload />
        <p class="privacy">
          <Icon name="fl_info" size={16} />
          <span>מסדי נתונים נפתחים לקריאה בלבד. הכלי לעולם לא משנה את הקבצים שלכם — כל תוצר נשמר כקובץ חדש.</span>
        </p>
      </aside>
    </main>
  );
}

/** "#/start/<id>": a path asks which task first; a task's sheet asks for its sources. */
export function StartTaskDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const id = store.startTask.value;
  return isPathId(id) ? <PathChooser key={id} path={id} onClose={onClose} /> : <TaskSheet key={id ?? ""} onClose={onClose} />;
}

/** The first question of a path: which task. Radio group (arrows move and select), then "continue". */
function PathChooser({ path, onClose }: { path: PathId; onClose: () => void }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const info = PATHS[path];
  const choices = TASK_PATHS.find((p) => p.id === path)!.choose.map((id) => TASKS.find((t) => t.id === id)!);
  const [picked, setPicked] = useState(choices[0]!.id);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const go = () => {
    const t = TASKS.find((x) => x.id === picked)!;
    // a guided task replaces the sheet with the guided flow, as its card did; the others go on to their own sheet
    if (t.guided) {
      store.dialog.value = null;
      store.startTask.value = null;
      store.guided.start();
    } else store.startTask.value = t.id;
  };
  return (
    <dialog ref={ref} class="start-task" onClose={onClose} aria-labelledby="start-title">
      <div class="dlg">
        <header>
          <Icon name={info.icon} size={24} />
          <h2 id="start-title">{info.title}</h2>
          <span class="grow" />
          <button class="icon-btn" onClick={() => ref.current?.close()} aria-label="סגירה" title="סגירה (Esc)">
            <Icon name="fl_dismiss" />
          </button>
        </header>
        <div class="body">
          <p class="muted" style="margin:0">{info.hint}.</p>
          <div role="radiogroup" aria-label={info.ask} class="choices" onKeyDown={rovingKeys}>
            {choices.map((t) => (
              <button key={t.id} class="choice" role="radio" data-task={t.id} aria-checked={picked === t.id} tabIndex={rovingTabIndex(picked === t.id)} onClick={() => setPicked(t.id)} onFocus={() => setPicked(t.id)} onDblClick={go}>
                <Icon name={t.icon} size={22} />
                <span>
                  <b>{t.title}</b>
                  <span class="muted">{t.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <footer>
          <button class="btn text" onClick={() => ref.current?.close()}>ביטול</button>
          <button class="btn filled" onClick={go}>
            <Icon name="oz_link" size={18} />
            המשך
          </button>
        </footer>
      </div>
    </dialog>
  );
}

/** The sheet of a guided workflow ("#/start/<id>"): one row per source it needs, then "start". */
function TaskSheet({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const task = TASKS.find((t) => t.id === store.startTask.value);
  const back = task ? pathOfTask(task.id) : undefined;
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
    // a database that was open already is not a new source (#22), but it fills the step all the same
    const held = new Set(Object.values(done).flatMap((d) => (Array.isArray(d) ? d : [])));
    const added = [...store.sources.peek().filter((s) => !before.has(s.info.id)).map((s) => s.info.id), ...store.lastOpen.reused.filter((id) => !held.has(id))];
    if (added.length) setDone((d) => ({ ...d, [i]: [...(Array.isArray(d[i]) ? (d[i] as string[]) : []), ...added] }));
    else if (store.linkState.peek().links.size !== links || store.pendingDbs.peek().length > pending) setDone((d) => ({ ...d, [i]: d[i] ?? true }));
  };
  const ready = task.steps.every((s, i) => s.optional || done[i]);
  // the sources already open (#22): a step takes each once, and the sheet offers them instead of asking again
  const openNow: OpenSource[] = store.sources.value.map((s) => ({ id: s.info.id, kind: s.info.kind, library: store.isLibrarySource(s.info.id) }));
  const taken = new Set(Object.values(done).flatMap((d) => (Array.isArray(d) ? d : [])));
  const use = (i: number, ids: string[]) => setDone((d) => ({ ...d, [i]: [...(Array.isArray(d[i]) ? (d[i] as string[]) : []), ...ids] }));
  const proposal = assignOpenSources(task.steps, openNow, done);
  const proposed = Object.keys(proposal).length;
  const start = () => {
    const then = task.then;
    const scoped = then.scopeStep !== undefined ? done[then.scopeStep] : undefined;
    const sourceId = Array.isArray(scoped) ? scoped[0] : undefined;
    store.intent.value = { ...(then.engine && { engine: then.engine }), ...(sourceId && { sourceId }), ...(then.allBooks && { allBooks: true }) };
    if (then.mode) store.suggestMode.value = then.mode;
    if (then.dbLinks) store.dbLinks.tab.value = "db";
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
          {proposed > 0 && (
            <div class="opened-offer">
              <span class="grow">יש כבר מקורות פתוחים שמתאימים למשימה הזו: לא צריך לבחור אותם שוב.</span>
              <button class="btn outlined" onClick={() => Object.entries(proposal).forEach(([i, ids]) => use(Number(i), ids))}>
                <Icon name="oz_check" size={16} />
                המשך עם המקורות הפתוחים
              </button>
            </div>
          )}
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
                  {!done[i] &&
                    candidatesFor(s, openNow, taken).map((c) => {
                      const src = store.sources.value.find((x) => x.info.id === c.id)!;
                      return (
                        <div key={c.id} class="opened offer">
                          <button class="btn text small" onClick={() => use(i, [c.id])} aria-label={`${s.label}: שימוש במקור הפתוח ${src.info.label}`}>
                            <Icon name="fl_checkmark_circle" size={14} />
                            שימוש במקור הפתוח: <SourceBadge source={src} name /> · {src.books.length.toLocaleString("he")} ספרים
                          </button>
                        </div>
                      );
                    })}
                  {done[i] === true && <div class="opened"><Icon name="fl_checkmark_circle" size={14} /> נטען</div>}
                  {s.dbHint && <OtzariaDbHint compact />}
                </div>
              </li>
            ))}
          </ol>
        </div>
        <footer>
          {back && (
            <button class="btn text" onClick={() => (store.startTask.value = back)} title="חזרה לבחירת המשימה">חזרה</button>
          )}
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
