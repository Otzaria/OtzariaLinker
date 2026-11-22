import { sourceIdOfBookKey, type BookHeading, type SourceBook } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import { stripTags } from "../core/text/html";
import { zipBundle } from "../formats/links-json/export";
import { personalLinkRows, validatePersonalRows, writePersonalLinksCsv, type PersonalCsvFile, type PersonalCsvProblem, type PersonalSkip } from "../formats/personal-csv";
import type { BooksService, CallOptions, Saver } from "./services";
import type { NoticeKind } from "./store";

/*
 * Export of a personal book's links to the OFFICIAL library, as the `links.csv` of the personal-database build (formats/personal-csv):
 * the project's links between a book of a personal source and a book of the official database, one row per line of the personal book.
 * The place of the target is the target book's own nearest heading above the line (what the importer matches by its table of
 * contents; offline there is nothing to check it against, so it is the book's heading text, not a confirmed tocEntry — the
 * problems list says what could not be placed). Nothing is written to any database (AGENTS.md §2.3): the result is files.
 */
export interface PersonalCsvHost {
  readonly allLinks: { readonly value: Link[] };
  bookOf(ref: BookRef): SourceBook | undefined;
  isLibrarySource(sourceId: string): boolean;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
}

export interface PersonalCsvBundle {
  files: PersonalCsvFile[];
  rows: number;
  /** links the format cannot say, each with its reason */
  skipped: PersonalSkip[];
  /** problems the import would refuse the file for (empty when the files are clean) */
  problems: PersonalCsvProblem[];
}

export class PersonalCsvState {
  constructor(
    private readonly host: PersonalCsvHost,
    private readonly service: Pick<BooksService, "headings" | "lines">,
    private readonly saver: Saver,
  ) {}

  /** The files for the project's links between personal books and the official library; null when cancelled or there is nothing to say. */
  async prepare(): Promise<PersonalCsvBundle | null> {
    const links = this.host.allLinks.value.filter((l) => l.provenance !== "db");
    const personal = (b: BookRef) => {
      const sb = this.host.bookOf(b);
      return !!sb && !this.host.isLibrarySource(sourceIdOfBookKey(sb.key));
    };
    const official = (b: BookRef) => {
      const sb = this.host.bookOf(b);
      return !!sb && this.host.isLibrarySource(sourceIdOfBookKey(sb.key));
    };
    // the headings of the official targets and the content lines of the personal sources, read once each
    const targets = new Map<string, BookHeading[]>();
    const content = new Map<string, Set<number>>();
    const ok = await this.host.runTask("קורא את הכותרות והשורות של הספרים…", async (opts) => {
      for (const l of links)
        for (const [mine, other] of [[l.source, l.target], [l.target, l.source]] as const) {
          if (!personal(mine.book) || !official(other.book)) continue;
          if (!targets.has(other.book.key)) targets.set(other.book.key, await this.service.headings(other.book.key, opts));
          if (!content.has(mine.book.key)) {
            const lines = await this.service.lines(mine.book.key, 0, Number.MAX_SAFE_INTEGER, opts);
            content.set(mine.book.key, new Set(lines.filter((x) => x.heading === null && stripTags(x.text).trim() !== "").map((x) => x.index)));
          }
        }
      return true;
    });
    if (ok === null) return null;
    const { rows, skipped } = personalLinkRows(links, {
      isPersonal: personal,
      isOfficial: official,
      contentLine: (b, line) => content.get(b.key)?.has(line) ?? false,
      positionOf: (side) => {
        const hs = targets.get(side.book.key);
        if (!hs) return null;
        let best: BookHeading | undefined;
        for (const h of hs) if (h.line <= side.line && h.level > 1 && (!best || h.line >= best.line)) best = h;
        const text = best ? stripTags(best.text).trim() : "";
        return text || null;
      },
    });
    const headingTexts = new Map<string, Set<string>>();
    for (const b of [...this.host.allLinks.value.flatMap((l) => [l.source.book, l.target.book])]) {
      const hs = targets.get(b.key);
      if (hs && !headingTexts.has(b.title)) headingTexts.set(b.title, new Set(hs.map((h) => stripTags(h.text).trim())));
    }
    const problems = validatePersonalRows(rows, { targetExists: (t) => headingTexts.has(t), positionExists: (t, p) => headingTexts.get(t)?.has(p) ?? false });
    return { files: writePersonalLinksCsv(rows).files, rows: rows.length, skipped, problems };
  }

  /** Saves the files: one links.csv as it is, several as one ZIP with the folders the personal-database build expects. */
  save(bundle: PersonalCsvBundle): void {
    if (!bundle.files.length) return void this.host.notify("warning", "אין קישורים בין ספר אישי לספר של המאגר הרשמי, ולכן אין מה לייצא.");
    const data = zipBundle(bundle.files.map((f) => ({ path: `${f.folder}/${f.name}`, text: f.text })));
    this.saver.save(`קישורים-לספרייה-האישית-${new Date().toISOString().slice(0, 10)}.zip`, data, "application/zip");
  }
}
