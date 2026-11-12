import { signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { BookHeading, SourceBook } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import { normalizeTitle, sourceTitleFromLinksFileName, titleFromPath2 } from "../core/links/titles";
import type { ValidationContext } from "../core/links/validate";
import { sefariaRefFromHeRef } from "../core/links/sefaria-ref";
import type { AltTocExportPlan } from "../formats/alt-toc/export";
import { linkToRecord, recordToLink } from "../formats/links-json/convert";
import { assertSafeExportPaths, planExport, zipBundle, type ExportPlan } from "../formats/links-json/export";
import { detectLayout } from "../formats/links-json/layout";
import { parseLinksJson } from "../formats/links-json/parse";
import { recordToObject } from "../formats/links-json/serialize";
import { parseLinksCsv } from "../formats/links-csv/parse";
import { guessRecordsMapping, parseRecords, recordsToLinksFiles, type RecordsMapping, type RecordsTable } from "../formats/records/records";
import { buildExportReport, REPORT_FILE_NAME } from "../formats/report/export-report";
import { nextSteps, type NextStepsRoute } from "../formats/report/next-steps";
import { planSefariaCsv, type SefariaCsvFile } from "../formats/sefaria-csv/write";
import type { AltTocState } from "./alt-toc";
import { addChanges, commit, fileChange, fileFingerprint, linksCount, type Change, type LibraryFile, type LinkState } from "./history";
import type { LineStore } from "./lines";
import type { BooksService, CallOptions, Saver } from "./services";
import type { NoticeKind } from "./store";

/*
 * Links in and out of the project: a book's links file from the library, a spreadsheet of new links,
 * a records file in someone else's layout (through the field-mapping dialog), and the export — the
 * plan, Sefaria's CSV layout, `_report.txt` and the download. Every import is ONE undoable action
 * (history.commit). The rules an import or export checks are not here: validation() and the lines it
 * reads (loadLinkLines) stay in the store, because the builder's live check uses the same context.
 * Kept out of store.ts on purpose, like alt-toc.ts and ranges.ts.
 */
export interface ExchangeHost {
  readonly linkState: Signal<LinkState>;
  readonly allLinks: ReadonlySignal<Link[]>;
  readonly booksByTitle: ReadonlySignal<Map<string, SourceBook[]>>;
  /** the link revision last written to disk — a saved export updates it */
  readonly savedRevision: Signal<number>;
  readonly exportPurpose: ReadonlySignal<"submission" | "private">;
  readonly lines: Pick<LineStore, "peek">;
  readonly altToc: Pick<AltTocState, "loadLines" | "plan">;
  bookOf(ref: BookRef): SourceBook | undefined;
  resolveTitle(title: string): BookRef | null;
  isSefariaOwned(book: { readonly title: string }): boolean;
  validation(): ValidationContext;
  loadLinkLines(label: string): Promise<boolean>;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
}

/** What the export dialog shows and saves: the links plan and the alt_toc files. */
export interface ExportBundle extends ExportPlan {
  altToc: AltTocExportPlan;
}

export class ExchangeState {
  /** files waiting for the field-mapping dialog, first one shown */
  readonly pendingRecords = signal<{ path: string; table: RecordsTable; mapping: RecordsMapping }[]>([]);

  /** numbers the files and sheets imported in this session, so their link ids never collide */
  private importSeq = 0;

  constructor(
    private readonly host: ExchangeHost,
    private readonly service: Pick<BooksService, "headings">,
    private readonly saver: Saver,
  ) {}

  /* ---------------- import ---------------- */

  /**
   * Loads a book's links file FROM THE LIBRARY: its records become "file" links, and the project now
   * holds that book's file (LinkState.files) — the export writes it back as the library's file plus
   * the user's changes, and replaces the library's file with it. Only a file that parsed counts as
   * loaded, and undoing the import forgets it (security review A1, A2).
   *
   * Loading a book's file again: the same file (fingerprint and every untouched record) only marks it
   * loaded in this session — that is how a file restored from a saved project is verified (A3). A
   * different file replaces the project's copy when the user changed nothing in it; otherwise nothing
   * changes and the user is told why (the tool never merges two versions of a file silently).
   */
  importLinksFile(path: string, text: string): void {
    const { host } = this;
    const sourceTitle = sourceTitleFromLinksFileName(path);
    if (!sourceTitle) return void host.notify("error", `"${path}": שם קובץ קישורים חייב להסתיים ב־‎_links.json, כי ממנו אוצריא יודעת מהו ספר המקור.`);
    const parsed = parseLinksJson(text);
    const fatal = parsed.issues.find((i) => i.index < 0 && i.level === "error" && (i.code === "file/not-json" || i.code === "file/not-array"));
    if (fatal)
      return void host.notify("error", `"${path}" לא נטען: ${fatal.message} קובץ הקישורים של "${sourceTitle}" לא נחשב טעון, ולכן ייצוא שלו עדיין מחכה לקובץ תקין מהספרייה.`);
    const sourceRef = host.resolveTitle(sourceTitle) ?? { key: `unresolved:${sourceTitle}`, title: sourceTitle, origin: "unknown" as const };
    const fileKey = `${sourceTitle}#${this.importSeq++}`;
    const issues = [...parsed.issues];
    const links = parsed.records.map((r, i) => {
      const { link, issues: more } = recordToLink(r, i, sourceRef, (t) => host.resolveTitle(t), `file:${fileKey}:${i}`);
      issues.push(...more);
      return link;
    });
    const file: LibraryFile = { title: sourceTitle, records: parsed.records.length, hash: fileFingerprint(text), verified: true, layout: detectLayout(text) };
    const s = host.linkState.value;
    const prev = s.files.get(sourceTitle);
    const held = [...s.links.values()].filter((l) => l.provenance === "file" && l.source.book.title === sourceTitle);
    let removed: Change[] = [];
    if (prev || held.length) {
      if (prev && sameLibraryFile(prev, file, held, links)) {
        if (prev.verified) return void host.notify("info", `קובץ הקישורים של "${sourceTitle}" כבר טעון, והקובץ שנבחר זהה לו. לא השתנה דבר.`);
        host.linkState.value = commit(s, `אימות ${sourceTitle}_links.json מול הספרייה`, [], Date.now(), [], [fileChange(s, sourceTitle, { ...prev, verified: true, layout: file.layout! })]);
        return void host.notify("success", `קובץ הקישורים של "${sourceTitle}" שנטען זהה לעותק שבפרויקט. הספר מוכן לייצוא.`);
      }
      const changed = held.filter((l) => l.status !== "existing").length;
      if (changed)
        return void host.notify(
          "error",
          `"${path}" שונה מקובץ הקישורים של "${sourceTitle}" שבפרויקט, ובפרויקט יש ${linksCount(changed)} ערוכים או מחוקים מתוכו. הכלי לא ממזג שתי גרסאות של קובץ. כדי לעבוד על הקובץ העדכני: בטלו או מחקו את השינויים בקישורים של הספר וטענו שוב; או אשרו בחלון הייצוא שהעותק שבפרויקט הוא העדכני.`,
        );
      removed = held.map((l) => ({ id: l.id, before: l }));
    }
    host.linkState.value = commit(s, `ייבוא ${sourceTitle}_links.json (${linksCount(links.length)})`, [...removed, ...addChanges(links)], Date.now(), [], [fileChange(s, sourceTitle, file)]);
    if (removed.length) host.notify("info", `העותק הקודם של קובץ הקישורים של "${sourceTitle}" (${linksCount(removed.length)}) הוחלף בקובץ שנטען.`);
    const errors = issues.filter((i) => i.level === "error");
    const details = issues.slice(0, 200).map((i) => `${i.index >= 0 ? `רשומה ${i.index + 1}: ` : ""}${i.message}`);
    if (parsed.generatorRejectsFile)
      host.notify("error", `"${path}": אוצריא הייתה דוחה את הקובץ הזה כולו כמו שהוא (${new Set(errors.map((e) => e.index)).size} רשומות פגומות). הרשומות התקינות נטענו; בייצוא הקובץ ייכתב מחדש תקין.`, details);
    else if (issues.length) host.notify("warning", `"${path}": נטענו ${links.length} קישורים, עם ${issues.length} הערות.`, details);
    else host.notify("success", `נטענו ${links.length.toLocaleString("he")} קישורים מ־"${path}".`);
    if (sourceRef.origin === "unknown") host.notify("info", `ספר המקור "${sourceTitle}" עדיין לא פתוח. פתחו אותו (או את המסד שבו הוא נמצא) כדי לראות את הקישורים על הטקסט.`);
  }

  /** A spreadsheet of links (CSV/TSV): NEW links, one batch per source book (importSheetLinks). */
  importLinksCsv(path: string, text: string): void {
    const r = parseLinksCsv(text, path);
    // a sheet whose columns are not the library's names: let the user map them instead of failing
    if (!r.files.length && r.problems.some((p) => p.startsWith("חסרה עמודה"))) return this.offerRecords(path, text);
    if (r.problems.length) this.host.notify(r.files.length ? "warning" : "error", `"${path}": ${r.problems.length} בעיות בגיליון.`, r.problems.slice(0, 100));
    this.importSheetLinks(path, r.files);
  }

  /* links in someone else's layout (JSON, JSON Lines, CSV with other columns): the field-mapping dialog */

  offerRecords(path: string, text: string): void {
    const table = parseRecords(text, path);
    if (!table) return void this.host.notify("error", `"${path}": לא נמצאו בקובץ רשומות קישורים (מערך של אובייקטים, JSON Lines או טבלה עם שורת כותרות).`);
    if (table.truncated)
      this.host.notify("warning", `"${path}" גדול מדי לייבוא מלא: ${[table.truncated.fields && `${table.truncated.fields.toLocaleString("he")} עמודות`, table.truncated.rows && `${table.truncated.rows.toLocaleString("he")} רשומות`].filter(Boolean).join(" ו־")} לא נקראו. פצלו את הקובץ, או השאירו בו רק את העמודות של הקישורים.`);
    this.pendingRecords.value = [...this.pendingRecords.value, { path, table, mapping: guessRecordsMapping(table) }];
  }

  /** Imports the first waiting file with the user's mapping, through the ordinary links-file import. */
  importRecords(mapping: RecordsMapping): void {
    const [first, ...rest] = this.pendingRecords.value;
    if (!first) return;
    const r = recordsToLinksFiles(first.table, mapping, first.path);
    this.pendingRecords.value = rest;
    if (r.problems.length) this.host.notify(r.files.length ? "warning" : "error", `"${first.path}": ${r.problems.length} רשומות לא יובאו.`, r.problems);
    this.importSheetLinks(first.path, r.files);
  }

  skipRecords(): void {
    this.pendingRecords.value = this.pendingRecords.value.slice(1);
  }

  /**
   * Links from a spreadsheet or a records file. They go through the links-file parser (one set of
   * rules), but they are NOT the library's file of their book: they are new links (provenance
   * "import", status "new"), validated and held back like any new link, and they never mark the
   * book's library file as loaded nor change how it is written (security review A1). Book titles are
   * matched exactly, and else by the generator's normalisation when that names exactly one open book
   * (ASCII " for gershayim and the like — compatibility review B7). ONE undoable action.
   */
  private importSheetLinks(path: string, files: readonly { sourceTitle: string; text: string }[]): void {
    const { host } = this;
    if (!files.length) return;
    const byNorm = new Map<string, Set<string>>();
    for (const t of host.booksByTitle.value.keys()) {
      const n = normalizeTitle(t);
      byNorm.set(n, (byNorm.get(n) ?? new Set()).add(t));
    }
    const fixed = new Map<string, string>();
    const resolve = (title: string): BookRef | null => {
      const exact = host.resolveTitle(title);
      if (exact) return exact;
      const hits = byNorm.get(normalizeTitle(titleFromPath2(title)));
      if (hits?.size !== 1) return null;
      const dbTitle = [...hits][0]!;
      fixed.set(titleFromPath2(title), dbTitle);
      return host.resolveTitle(dbTitle);
    };
    const links: Link[] = [];
    const issues: string[] = [];
    let dropped = 0;
    for (const f of files) {
      const parsed = parseLinksJson(f.text);
      const sourceRef = resolve(f.sourceTitle) ?? { key: `unresolved:${f.sourceTitle}`, title: f.sourceTitle, origin: "unknown" as const };
      const batch = this.importSeq++;
      for (const i of parsed.issues) issues.push(`${f.sourceTitle}${i.index >= 0 ? `, רשומה ${i.index + 1}` : ""}: ${i.message}`);
      parsed.records.forEach((r, i) => {
        const { link, issues: more } = recordToLink(r, i, sourceRef, resolve, `imp:${batch.toString(36)}:${i}`);
        for (const x of more) issues.push(`${f.sourceTitle}, רשומה ${i + 1}: ${x.message}`);
        // a new link: none of the library-file bookkeeping (position, key order, unknown fields)
        const { fileIndex: _i, keyOrder: _k, typeNull: _t, passthrough, ...rest } = link;
        if (passthrough && Object.keys(passthrough).length) dropped++;
        links.push({ ...rest, status: "new", provenance: "import" });
      });
    }
    if (links.length) this.commit(`ייבוא ${linksCount(links.length)} מ־"${path}"`, addChanges(links));
    const notes = [
      ...[...fixed].map(([from, to]) => `השם "${from}" הותאם לספר "${to}" (אותו שם אחרי הנרמול של אוצריא).`),
      ...(dropped ? [`ב־${linksCount(dropped)} היו עמודות שאינן שדות של קובץ קישורים; הן לא יובאו.`] : []),
      ...issues,
    ];
    if (!links.length) return void host.notify("error", `"${path}": לא יובא אף קישור.`, notes.slice(0, 200));
    host.notify(
      notes.length ? "warning" : "success",
      `יובאו ${linksCount(links.length)} חדשים מ־"${path}". הם נבדקים בייצוא כמו כל קישור חדש, וקובץ הקישורים של כל ספר בספרייה עדיין צריך להיטען לפני ייצוא.`,
      notes.length ? notes.slice(0, 200) : undefined,
    );
  }

  /* ---------------- export ---------------- */

  /** Loads every line the export must check (ends of every link, alt_toc lines) and returns the plan. */
  async prepareExport(): Promise<ExportBundle | null> {
    const { host } = this;
    if (!(await host.loadLinkLines("בודק את הקישורים לפני הייצוא…"))) return null;
    if (host.exportPurpose.value === "submission") this.fillSefariaRefs();
    await host.altToc.loadLines();
    const files = host.linkState.value.files;
    return { ...planExport(host.allLinks.value, host.validation(), { layouts: (t) => files.get(t)?.layout, loadedFile: (t) => files.get(t)?.verified === true }), altToc: host.altToc.plan() };
  }

  /**
   * Fills the Sefaria refs the library's sync needs where the user did not, from the database heRef of
   * the line (core/links/sefaria-ref.ts) — ONE undoable action, said in a notice. Only links the user
   * made or changed; an untouched library record is left as it is in the library (B1).
   */
  private fillSefariaRefs(): void {
    const { host } = this;
    const s = host.linkState.value;
    const changes: Change[] = [];
    for (const l of s.links.values()) {
      if (l.status === "deleted" || l.provenance === "db" || (l.provenance === "file" && l.status === "existing")) continue;
      const srcSef = host.isSefariaOwned(l.source.book);
      const tgtSef = host.isSefariaOwned(l.target.book);
      if (srcSef === tgtSef) continue;
      const side = srcSef ? l.source : l.target;
      if ((srcSef ? l.ref1 : l.ref2) !== undefined) continue;
      const b = host.bookOf(side.book);
      const ref = b && sefariaRefFromHeRef(host.lines.peek(b.key, side.line)?.heRef);
      if (!ref) continue;
      changes.push({ id: l.id, before: l, after: { ...l, ...(srcSef ? { ref1: ref } : { ref2: ref }) } });
    }
    if (!changes.length) return;
    this.commit(`השלמת ציוני ספריא (ref_1/ref_2) ל־${linksCount(changes.length)}`, changes);
    host.notify("info", `הכלי השלים ציון ספריא באנגלית (ref_1/ref_2) ל־${linksCount(changes.length)} מתוך שם המקום שבמסד. אפשר לבטל ב־Ctrl+Z.`);
  }

  /** The links the plan writes, as CSV in Sefaria's layout (reads the headings of their books for the citations). */
  async prepareSefariaCsv(plan: ExportPlan): Promise<SefariaCsvFile[] | null> {
    const { host } = this;
    const dropped = new Set(["export/heading-line", "export/line-out-of-range", "export/line-not-in-db"]);
    const bad = new Set(plan.warned.filter((w) => w.problems.some((p) => dropped.has(p.code))).map((w) => w.link.id));
    const links = plan.written.filter((l) => !bad.has(l.id));
    const headings = new Map<string, BookHeading[]>();
    const ok = await host.runTask("קורא את כותרות הספרים למראי המקום…", async (opts) => {
      const keys = new Set(links.flatMap((l) => [host.bookOf(l.source.book)?.key, l.heRef2 ? undefined : host.bookOf(l.target.book)?.key]).filter((k): k is string => !!k));
      let done = 0;
      for (const key of keys) {
        headings.set(key, await this.service.headings(key, opts));
        opts.onProgress?.(++done, keys.size);
      }
      return true;
    });
    if (!ok) return null;
    return planSefariaCsv(links, (ref) => {
      const b = host.bookOf(ref);
      return b && headings.get(b.key);
    });
  }

  /** `_report.txt` for a plan (and the CSV files, when exporting as CSV). */
  exportReport(plan: ExportBundle, csv?: readonly SefariaCsvFile[]): string {
    return buildExportReport({ date: new Date().toLocaleString("he-IL"), app: APP_VERSION, format: csv ? "sefaria-csv" : "json", links: plan, ...(csv && { csv }), altToc: plan.altToc, purpose: this.host.exportPurpose.peek() });
  }

  /** What to do with the files of this export, the route of its purpose first (audit F13). */
  nextSteps(plan: ExportBundle, csv?: readonly SefariaCsvFile[]): NextStepsRoute[] {
    const files = (csv ? csv.length : plan.files.length) + plan.altToc.files.length;
    return nextSteps({ format: csv ? "sefaria-csv" : "json", purpose: this.host.exportPurpose.value, altToc: plan.altToc.files.length > 0, zip: files > 1 });
  }

  saveReport(plan: ExportBundle, csv?: readonly SefariaCsvFile[]): void {
    this.saver.save(REPORT_FILE_NAME, this.exportReport(plan, csv), "text/plain;charset=utf-8");
  }

  /**
   * Saves the export. One file alone downloads as that file; anything more is one ZIP laid out like
   * the library — links/, alt_toc/ — with `_report.txt` at its root. `csv` replaces the links files
   * with Sefaria-layout CSV files.
   */
  saveExport(plan: ExportPlan | ExportBundle, csv?: readonly SefariaCsvFile[]): void {
    const { host } = this;
    const bundle: ExportBundle = "altToc" in plan ? plan : { ...plan, altToc: { files: [], heldBack: [] } };
    const data = [
      ...(csv ? csv.map((f) => ({ path: f.name, text: f.text, mime: "text/csv;charset=utf-8" })) : plan.files.map((f) => ({ path: `links/${f.name}`, text: f.text, mime: "application/json" }))),
      ...bundle.altToc.files.map((f) => ({ path: `alt_toc/${f.name}`, text: f.text, mime: "application/json" })),
    ];
    if (!data.length) return;
    try {
      assertSafeExportPaths(data);
      if (data.length === 1) this.saver.save(data[0]!.path.split("/").at(-1)!, data[0]!.text, data[0]!.mime);
      else this.saver.save(`links-${new Date().toISOString().slice(0, 10)}.zip`, zipBundle([...data, { path: REPORT_FILE_NAME, text: this.exportReport(bundle, csv) }]), "application/zip");
    } catch (err) {
      return void host.notify("error", (err as Error).message);
    }
    host.savedRevision.value = host.linkState.value.revision;
    const alt = bundle.altToc.files.length;
    host.notify("success", `יוצאו ${(csv ? csv.reduce((n, f) => n + f.rows, 0) : plan.written.length).toLocaleString("he")} קישורים ב־${csv ? csv.length : plan.files.length} קבצים${alt ? `, ומבני כותרות ל־${alt} ספרים` : ""}.`);
  }

  private commit(label: string, changes: Change[]): void {
    this.host.linkState.value = commit(this.host.linkState.value, label, changes);
  }
}

/**
 * The file just loaded is the file the project already holds: same fingerprint and record count, and
 * every record the user did not touch is the same record at the same position. The fingerprint alone
 * is a claim a project file makes; the records are checked so a forged snapshot is never "verified".
 */
function sameLibraryFile(prev: LibraryFile, file: LibraryFile, held: readonly Link[], loaded: readonly Link[]): boolean {
  if (prev.hash !== file.hash || prev.records !== file.records) return false;
  const rec = (l: Link) => JSON.stringify(recordToObject(linkToRecord(l)));
  return held.every((l) => l.status !== "existing" || (l.fileIndex !== undefined && loaded[l.fileIndex] !== undefined && rec(loaded[l.fileIndex]!) === rec(l)));
}

const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
