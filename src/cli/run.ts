import { existsSync, mkdirSync, openAsBlob, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { booksService } from "../app/books-service";
import { sourceIdOfBookKey } from "../core/books";
import { LinkerError } from "../core/errors";
import { linePairIdentity } from "../core/links/equality";
import type { Link } from "../core/links/model";
import { appendRecords, externalRecords, officialRefKey, recordedLinks, type RecordedLinks } from "../formats/links-json/external";
import { parseLinksJson } from "../formats/links-json/parse";
import { detectRepoLayout, filterBooks, nextCsvFolders, type RepoLayout } from "../headless/repo-layout";
import type { Confidence, EngineId } from "../linking/automatic";
import { SourceRegistry } from "../sources/registry";
import { loadPreferences } from "../state/preferences";
import type { InputFile } from "../state/services";
import { AppStore } from "../state/store";
import { inProcessCall, sourcesHandlers } from "../workers/sources-handlers";
import { openRepo } from "./node-files";

/*
 * The folder-repository runner (V7 §4.16, #46; docs/HEADLESS.md). It drives the SAME code the app runs — the store, the guided
 * flow "link a folder to Otzaria" (state/guided-flow.ts: plan, max-link run, approval, the check and the export plan), the
 * registry and the worker's jobs called in process (workers/sources-handlers.ts, as the integration tests do) — with Node's file
 * access instead of a page. Nothing of the linking is re-implemented here: this file reads the repository, decides where each
 * produced file goes in it (headless/repo-layout.ts), and writes into --out.
 *
 * Safety, enforced here and asserted by tests/integration/cli/:
 *   • read only: the repository and the database are opened with fs.openAsBlob (the lazy reader reads the database by slices);
 *   • nothing is written outside --out, and --out may not be the repository or inside it;
 *   • nothing is overwritten: --out must be empty or new, and every file is created with the "wx" flag;
 *   • a dry run writes only the report.
 */
export interface RunOptions {
  repo: string;
  db?: string;
  out?: string;
  dryRun?: boolean;
  include?: readonly string[];
  exclude?: readonly string[];
  limit?: number;
  /** the lowest confidence approved (default "certain", as the guided flow's "approve all certain") */
  minConfidence?: Confidence;
  /**
   * default "submission": the official generator's reading of a links file, which the builders of these repositories follow
   * (zmanenu: "source" is stored reversed, as in the official build); "private" is Otzaria's personal import of a links file
   */
  purpose?: "private" | "submission";
  /** the pair engines to use instead of every one that fits (headings, dibur-hamatchil) */
  methods?: readonly EngineId[];
}

export interface OutputFile {
  /** relative to the repository (and to --out) */
  path: string;
  /** "new": the repository has no such file; "update": a new version of the repository's file (the repository is not touched) */
  action: "new" | "update";
  kind: "links-json" | "links-csv";
  /** records (or CSV rows) in the file as written, and in the repository's file before */
  records: number;
  before?: number;
  text: string;
}

export interface RunReport {
  repo: string;
  db: string | null;
  layout: RepoLayout["kind"];
  dryRun: boolean;
  books: { total: number; selected: number; titles: string[] };
  skippedFiles: { path: string; reason: string }[];
  duplicateTitles: { title: string; paths: string[] }[];
  existingLinksFiles: number;
  /** existing files the official format cannot read whole (zmanenu target_library/book_2 records): appended to, never rewritten */
  appendedOnly: string[];
  /**
   * approved links that the records of those files already say (the same two lines, either direction, any type; or the same official
   * line by heRef_2): not written, so the repository does not get a duplicate (V7 round 2, item 9)
   */
  alreadyInRepository: number;
  plan: { steps: number; perEngine: Record<string, number> };
  suggestions: { total: number; approved: number; minConfidence: Confidence; byConfidence: Partial<Record<Confidence, number>> };
  links: { internal: number; external: number };
  export: { written: number; heldBack: { title: string; line: number; reasons: string[] }[]; warned: number };
  external: { mode: RepoLayout["external"]; written: number; skipped: { reason: string; count: number }[] };
  files: Omit<OutputFile, "text">[];
  /** the repository's links files the run would write back exactly as they are (not written) */
  unchanged: string[];
  /** what the store told the user on the way (warnings and errors) */
  notices: { kind: string; text: string }[];
}

export const REPORT_JSON = "linker-report.json";
export const REPORT_TXT = "linker-report.txt";

export async function runRepository(o: RunOptions): Promise<{ report: RunReport; files: OutputFile[] }> {
  const out = o.out ? checkOut(o.repo, o.out) : null;
  if (!out && !o.dryRun) throw new LinkerError("repo/bad-args", "חסר --out: תיקייה ריקה שאליה ייכתבו הקבצים. הכלי לעולם אינו כותב לתוך המאגר. להרצה בלי כתיבה, הוסיפו --dry-run.");
  if (o.db && !existsSync(o.db)) throw new LinkerError("repo/not-found", `מסד הספרים "${o.db}" לא נמצא. תנו את הנתיב ל־seforim.db של אוצריא.`, { path: o.db });

  const repo = await openRepo(o.repo);
  const layout = detectRepoLayout(repo.paths);
  const selected = filterBooks(layout.books, { ...(o.include && { include: o.include }), ...(o.exclude && { exclude: o.exclude }), ...(o.limit !== undefined && { limit: o.limit }) });
  const titles = new Set(selected.map((b) => b.title));

  const registry = new SourceRegistry();
  const store = new AppStore(booksService(inProcessCall(sourcesHandlers(registry))), { save: () => undefined }, loadPreferences(null));
  store.exportPurpose.value = o.purpose ?? "submission";
  const notices: RunReport["notices"] = [];
  const seenNotice = new Set<number>();
  store.notices.subscribe((list) => {
    for (const n of list) if (!seenNotice.has(n.id)) (seenNotice.add(n.id), n.kind !== "success" && n.kind !== "info" && notices.push({ kind: n.kind, text: n.text }));
  });

  // the books' existing links files: loaded into the project (so "exists" and the merged file are the app's), unless the official
  // format cannot read all of their records — those are kept aside and appended to, so no record of them is ever lost
  const imports: InputFile[] = [];
  const keptAside = new Map<string, { path: string; text: string; records: number }>();
  for (const title of titles) {
    const f = layout.linksFileFor(title);
    if (!f.exists) continue;
    const text = await repo.text(f.path);
    const parsed = parseLinksJson(text);
    if (parsed.generatorRejectsFile) keptAside.set(title, { path: f.path, text, records: countRecords(text) });
    else imports.push(await repo.input(f.path));
  }
  // what the records kept aside already link: never loaded, so the run compares its approved links with them here
  const recorded: RecordedLinks = { pairs: new Set(), officialRefs: new Set() };
  for (const [title, aside] of keptAside) recordedLinks(title, aside.text, recorded);

  const g = store.guided;
  g.start();
  if (selected.length) await g.addBooks([...(await Promise.all(selected.map((b) => repo.input(b.path)))), ...imports]);
  if (o.db) await g.addBases([{ path: o.db.split(/[\\/]/).at(-1)!, blob: await openAsBlob(resolve(o.db)) }]);
  if (o.methods?.length) g.setMethods(new Set(o.methods));
  const repoSources = new Set(g.bookSources.value);
  const plan = g.plan.value;

  let approved = 0;
  let total = 0;
  const byConfidence: Partial<Record<Confidence, number>> = {};
  const minConfidence = o.minConfidence ?? "certain";
  if (plan && plan.steps.length && (await g.run())) {
    const all = store.suggestions.run.value?.result.suggestions ?? [];
    total = all.length;
    for (const s of all) byConfidence[s.confidence] = (byConfidence[s.confidence] ?? 0) + 1;
    approved = store.suggestions.approve(store.suggestions.pendingAtLeast(minConfidence));
  }

  // which links are the repository's own and which reach the official library
  const isRepo = (key: string) => repoSources.has(sourceIdOfBookKey(key));
  const isLibrary = (key: string) => store.isLibrarySource(sourceIdOfBookKey(key));
  const approvedLinks = store.allLinks.value.filter((l) => l.status === "new" && l.provenance === "auto");
  // a link a kept-aside record already says (book_2, path_2 or target_library by line): taken out before anything is written
  const recordedAgain = approvedLinks.filter((l) => recorded.pairs.has(linePairIdentity(l)));
  if (recordedAgain.length) store.deleteLinks(recordedAgain.map((l) => l.id));
  let alreadyInRepository = recordedAgain.length;
  const made = approvedLinks.filter((l) => !recordedAgain.includes(l));
  const internal = made.filter((l) => isRepo(l.source.book.key) && isRepo(l.target.book.key));
  const external = made.filter((l) => !internal.includes(l) && (isRepo(l.source.book.key) || isRepo(l.target.book.key)) && (isLibrary(l.source.book.key) || isLibrary(l.target.book.key)));

  const files: OutputFile[] = [];
  const extReport: RunReport["external"] = { mode: layout.external, written: 0, skipped: [] };
  const tally = (reasons: string[]) => {
    const m = new Map<string, number>();
    for (const r of reasons) m.set(r, (m.get(r) ?? 0) + 1);
    return [...m].map(([reason, count]) => ({ reason, count }));
  };
  let zmanenuExternal: ReturnType<typeof externalRecords> | null = null;
  if (external.length && layout.external === "links-csv") {
    const csv = await store.personalCsv.prepare();
    if (csv) {
      const folders = nextCsvFolders(layout.csvFolders ?? [], csv.files.map((f) => f.folder));
      csv.files.forEach((f, i) => files.push({ path: `${layout.csvRoot}/${folders[i]}/${f.name}`, action: "new", kind: "links-csv", records: f.rows, text: f.text }));
      extReport.written = csv.rows;
      extReport.skipped = tally(csv.skipped.map((s) => s.text));
    }
  } else if (external.length && layout.external === "target-library") {
    const heRefs = new Map<string, string | null>();
    for (const l of external)
      for (const side of [l.source, l.target])
        if (isLibrary(side.book.key)) {
          await store.lines.load(side.book.key, side.line, side.line);
          heRefs.set(`${side.book.key}#${side.line}`, store.lines.peek(side.book.key, side.line)?.heRef ?? null);
        }
    // a link to the official line a target_library record already names by heRef_2
    const heRefOf = (s: Link["source"]) => heRefs.get(`${s.book.key}#${s.line}`) ?? null;
    const byRef = external.filter((l) => {
      const [mine, other] = isRepo(l.source.book.key) ? [l.source, l.target] : [l.target, l.source];
      const ref = heRefOf(other);
      return !!ref && recorded.officialRefs.has(officialRefKey(mine.book.title, mine.line, other.book.title, ref));
    });
    alreadyInRepository += byRef.length;
    zmanenuExternal = externalRecords(external.filter((l) => !byRef.includes(l)), {
      isRepo: (b) => isRepo(b.key),
      isOfficial: (b) => isLibrary(b.key),
      heRefOf,
    });
    extReport.skipped = tally(zmanenuExternal.skipped.map((s) => s.text));
  }
  // links-json (a plain folder): the official library's own record, written with the rest by the export below
  if (layout.external !== "links-json" && external.length) store.deleteLinks(external.map((l) => l.id));

  await g.check();
  const bundle = g.bundle.value;
  const byPath = new Map<string, OutputFile>();
  const fileFor = (title: string) => layout.linksFileFor(title);
  for (const f of bundle?.files ?? []) {
    const at = fileFor(f.sourceTitle);
    const aside = keptAside.get(f.sourceTitle);
    if (aside) {
      // the repository's file is not the official format: the new records go after its own, which stay as they are
      const added = appendRecords(aside.text, (JSON.parse(f.text) as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object"));
      byPath.set(at.path, { path: at.path, action: "update", kind: "links-json", records: aside.records + added.added, before: aside.records, text: added.text });
    } else byPath.set(at.path, { path: at.path, action: at.exists ? "update" : "new", kind: "links-json", records: f.records, ...(f.before !== undefined && { before: f.before }), text: f.text });
  }
  // a book whose file the export writes back exactly as the repository has it is not a change: not written, only counted
  const unchanged: string[] = [];
  for (const [path, f] of byPath) if (f.action === "update" && f.text === (await repo.text(path))) (unchanged.push(path), byPath.delete(path));
  if (zmanenuExternal)
    for (const [title, records] of zmanenuExternal.byTitle) {
      const at = fileFor(title);
      const prev = byPath.get(at.path);
      const aside = keptAside.get(title);
      const base = prev?.text ?? aside?.text ?? (at.exists ? await repo.text(at.path) : null);
      const before = prev?.before ?? aside?.records ?? (base !== null ? countRecords(base) : undefined);
      const added = appendRecords(base, records);
      extReport.written += added.added;
      if (!added.added && !prev) continue;
      byPath.set(at.path, { path: at.path, action: at.exists ? "update" : "new", kind: "links-json", records: countRecords(added.text), ...(before !== undefined && { before }), text: added.text });
    }
  files.unshift(...[...byPath.values()].filter((f) => !(f.action === "update" && unchanged.includes(f.path))).sort((a, b) => (a.path < b.path ? -1 : 1)));

  const report: RunReport = {
    repo: repo.root,
    db: o.db ? resolve(o.db) : null,
    layout: layout.kind,
    dryRun: !!o.dryRun,
    books: { total: layout.books.length, selected: selected.length, titles: selected.map((b) => b.title) },
    skippedFiles: layout.skipped,
    duplicateTitles: layout.duplicateTitles,
    existingLinksFiles: layout.linksFiles.length,
    appendedOnly: [...keptAside.values()].map((a) => a.path),
    alreadyInRepository,
    plan: { steps: plan?.steps.length ?? 0, perEngine: { ...(plan?.perEngine ?? {}) } },
    suggestions: { total, approved, minConfidence, byConfidence },
    links: { internal: internal.length, external: external.length },
    export: {
      written: bundle?.written.length ?? 0,
      heldBack: (bundle?.heldBack ?? []).map((h) => ({ title: h.link.source.book.title, line: h.link.source.line + 1, reasons: h.problems.filter((p) => p.severity === "error").map((p) => p.message) })),
      warned: bundle?.warned.length ?? 0,
    },
    external: extReport,
    files: files.map(({ text: _t, ...f }) => f),
    unchanged,
    notices,
  };

  if (out) {
    mkdirSync(out, { recursive: true });
    if (!o.dryRun) for (const f of files) writeNew(out, f.path, f.text);
    writeNew(out, REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
    writeNew(out, REPORT_TXT, reportText(report));
  }
  return { report, files };
}

function countRecords(text: string): number {
  try {
    const d = JSON.parse(text.replace(/^﻿/, "")) as unknown;
    return Array.isArray(d) ? d.length : 0;
  } catch {
    return 0;
  }
}

/**
 * The path a file system really means: the nearest existing ancestor through realpath (junctions, symlinks, subst drives and,
 * on Windows, the stored letter case), plus the part that does not exist yet as given. Case-folded where the file system
 * ignores case (win32, darwin), so `C:\x\Repo` and `C:\x\repo` compare equal (V7 PR4 review, finding 2).
 */
function realKey(p: string): string {
  let head = resolve(p);
  const rest: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = join(realpathSync.native(head), ...rest);
      break;
    } catch {
      const up = dirname(head);
      if (up === head) {
        real = resolve(p);
        break;
      }
      rest.unshift(basename(head));
      head = up;
    }
  }
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
}

/** --out: never the repository, inside it or holding it, never a file, and empty (nothing in it is ever replaced). */
function checkOut(repo: string, out: string): string {
  const o = resolve(out);
  const [rk, ok] = [realKey(repo), realKey(out)];
  const inside = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
  if (inside(ok, rk)) throw new LinkerError("repo/unsafe-out", `תיקיית הפלט "${out}" היא המאגר עצמו או בתוכו. הכלי אינו כותב לתוך המאגר: בחרו תיקייה מחוץ לו.`, { out: o });
  if (inside(rk, ok)) throw new LinkerError("repo/unsafe-out", `תיקיית הפלט "${out}" מכילה את המאגר (המאגר נמצא בתוכה). הכלי אינו כותב לתיקייה שהמאגר בתוכה: בחרו תיקייה ריקה מחוץ למאגר.`, { out: o });
  if (existsSync(o)) {
    if (!statSync(o).isDirectory()) throw new LinkerError("repo/unsafe-out", `"${out}" הוא קובץ, לא תיקייה. תנו תיקייה ריקה או חדשה.`, { out: o });
    if (readdirSync(o).length) throw new LinkerError("repo/exists", `תיקיית הפלט "${out}" אינה ריקה. הכלי אינו דורס קבצים: תנו תיקייה ריקה או חדשה.`, { out: o });
  }
  return o;
}

/** A file under --out, created and never replaced ("wx"); a path that would leave --out is refused. */
function writeNew(out: string, rel: string, text: string): void {
  const abs = resolve(out, ...rel.split("/"));
  const back = relative(out, abs);
  if (!back || back.startsWith("..") || resolve(abs) !== abs) throw new LinkerError("repo/unsafe-out", `הנתיב "${rel}" יוצא מתיקיית הפלט, ולכן לא נכתב.`, { path: rel });
  mkdirSync(dirname(abs), { recursive: true });
  try {
    writeFileSync(abs, text, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new LinkerError("repo/exists", `"${rel}" כבר קיים בתיקיית הפלט, והכלי אינו דורס קבצים.`, { path: rel });
    throw err;
  }
}

/** The report in words (Hebrew), for a person; the JSON beside it is for scripts. */
export function reportText(r: RunReport): string {
  const L: string[] = [];
  L.push(`דוח OtzariaLinker — ${r.dryRun ? "הרצה יבשה (לא נכתב אף קובץ קישורים)" : "הרצה"}`);
  L.push(`מאגר: ${r.repo} (${KIND_TEXT[r.layout]})`);
  L.push(`מסד אוצריא: ${r.db ?? "— (רק קישורים בתוך המאגר)"}`);
  L.push(`ספרים: ${r.books.selected} נבחרו מתוך ${r.books.total}. קובצי קישורים קיימים במאגר: ${r.existingLinksFiles}.`);
  if (r.duplicateTitles.length) L.push(`לא קושרו, כי כמה קבצים יוצרים אותו שם ספר: ${r.duplicateTitles.map((d) => `"${d.title}" (${d.paths.join(", ")})`).join("; ")}.`);
  if (r.appendedOnly.length) L.push(`קבצים שיש בהם רשומות שהפורמט הרשמי אינו קורא (target_library, book_2): הרשומות החדשות נוספות אחרי הקיימות, שנשארות כמו שהן: ${r.appendedOnly.join(", ")}.`);
  if (r.appendedOnly.length || r.alreadyInRepository) L.push(`קישורים שאושרו ולא נכתבו, כי הם כבר כתובים ברשומות של המאגר: ${r.alreadyInRepository} (אותן שתי שורות בכל כיוון ובכל סוג, או אותה שורה רשמית לפי heRef_2).`);
  L.push(`תוכנית: ${r.plan.steps} שלבים (${Object.entries(r.plan.perEngine).map(([e, n]) => `${e}: ${n}`).join(", ") || "—"}).`);
  L.push(`הצעות: ${r.suggestions.total}; אושרו ${r.suggestions.approved} (מרמת "${CONF_TEXT[r.suggestions.minConfidence]}" ומעלה).`);
  L.push(`קישורים: ${r.links.internal} בתוך המאגר, ${r.links.external} אל הספרייה הרשמית (${EXT_TEXT[r.external.mode]}: נכתבו ${r.external.written}).`);
  for (const s of r.external.skipped) L.push(`  לא נכתבו ${s.count}: ${s.reason}`);
  L.push(`ייצוא: ${r.export.written} רשומות נכתבו, ${r.export.heldBack.length} מוחזקות, ${r.export.warned} עם אזהרה.`);
  for (const h of r.export.heldBack.slice(0, 50)) L.push(`  מוחזק: "${h.title}" שורה ${h.line}: ${h.reasons.join(" ")}`);
  L.push("");
  L.push(r.files.length ? `קבצים${r.dryRun ? " שהיו נכתבים" : " שנכתבו לתיקיית הפלט"} (נתיב במאגר):` : "אין קובץ לכתוב.");
  for (const f of r.files) L.push(`  ${f.action === "new" ? "חדש " : "עדכון"}  ${f.path}  (${f.before !== undefined ? `${f.before} ← ` : ""}${f.records} ${f.kind === "links-csv" ? "שורות" : "רשומות"})`);
  if (r.unchanged.length) L.push(`לא השתנו (לא נכתבו): ${r.unchanged.join(", ")}.`);
  if (r.notices.length) {
    L.push("");
    L.push("הודעות:");
    for (const n of r.notices.slice(0, 100)) L.push(`  [${n.kind}] ${n.text}`);
  }
  L.push("");
  L.push("המאגר לא שונה. כדי להחיל: העתיקו את הקבצים מתיקיית הפלט אל אותם נתיבים במאגר, ובדקו את ה־diff לפני commit.");
  return `${L.join("\n")}\n`;
}

const KIND_TEXT: Record<RepoLayout["kind"], string> = { zmanenu: "מבנה zmanenu-library", "unofficial-books": "מבנה Otzarya-Unofficial-Books", folder: "תיקיית ספרים" };
const EXT_TEXT: Record<RepoLayout["external"], string> = { "target-library": "רשומות target_library בקובצי הקישורים", "links-csv": "קובצי links.csv", "links-json": "רשומות _links.json רגילות" };
const CONF_TEXT: Record<Confidence, string> = { certain: "ודאית", high: "גבוהה", possible: "אפשרית", ambiguous: "עמומה", none: "ללא" };

