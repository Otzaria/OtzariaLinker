import { pushTo } from "../../core/collections";
import type { Link } from "../../core/links/model";
import { otzariaBookTitle } from "../../core/links/titles";
import { LinkerError } from "../../core/errors";
import { decodeText } from "../../core/text/decode";
import { headingLevel, stripTags } from "../../core/text/html";
import type { BookSource, LineChunk, SourceBook, SourceInfo, SourceLine } from "../book-source";

/*
 * Books from .txt files (one file, many files, a folder, a ZIP's contents). A library book's lines
 * are split exactly as the generator splits them (Java BufferedReader.readLine via
 * exactLineSequence, BoundedGeneratorInput.kt:170): on \r\n, \r or \n, with one empty line after a
 * trailing line break, after removing a leading BOM. Line numbers are therefore identical to the
 * database's lineIndex for the same file.
 */
export function splitBookLines(text: string): string[] {
  return text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
}

export interface TextFile {
  /** path relative to the chosen folder/ZIP root, or just the file name */
  path: string;
  read(): Promise<Uint8Array>;
}

/** #41 B10: the generator breaks a line at a lone CR, Otzaria's personal import does not — what the user hears, with what to do. */
export function loneCrMessage(paths: readonly string[]): string {
  const names = paths.slice(0, 5).map((p) => `"${p}"`).join(", ") + (paths.length > 5 ? "…" : "");
  const where = paths.length === 1 ? `בקובץ ${names} יש` : `ב־${paths.length} קבצים (${names}) יש`;
  return `${where} מעבר שורה מסוג CR בלבד (בלי LF). הכלי, כמו הספרייה, סופר אותו כשורה חדשה, אבל ייבוא של ספר אישי באוצריא לא — ושם כל מספרי השורות שאחריו יוזזו. לספר אישי: שמרו את הקובץ מחדש עם מעברי שורה רגילים (LF או CRLF) ופתחו אותו שוב.`;
}

export class TextFilesSource implements BookSource {
  private readonly cache = new Map<string, string[]>();
  private readonly byKey: Map<string, TextFile>;
  readonly info: SourceInfo;

  constructor(id: string, label: string, private readonly files: readonly TextFile[]) {
    this.byKey = new Map(files.map((f) => [`${id}:${f.path}`, f]));
    this.info = { id, kind: "text-files", label, warnings: [] };
    const titles = new Map<string, string[]>();
    for (const f of files) {
      const t = otzariaBookTitle(stemOf(f.path));
      pushTo(titles, t, f.path);
    }
    for (const [t, paths] of titles)
      if (paths.length > 1)
        this.info.warnings.push({ code: "source/duplicate-title", message: `כמה קבצים יוצרים את אותו שם ספר "${t}" (${paths.join(", ")}). בספריית אוצריא רק אחד מהם יכול להתקיים; הכלי מציג את כולם ומבחין ביניהם לפי הנתיב.` });
  }

  async books(): Promise<SourceBook[]> {
    return this.files.map((f) => ({
      key: `${this.info.id}:${f.path}`,
      title: otzariaBookTitle(stemOf(f.path)),
      origin: "otzaria",
      path: f.path,
      ...(this.cache.has(`${this.info.id}:${f.path}`) && { lineCount: this.cache.get(`${this.info.id}:${f.path}`)!.length }),
    }));
  }

  async lines(bookKey: string, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<SourceLine[]> {
    const all = await this.load(bookKey);
    const out: SourceLine[] = [];
    for (let i = Math.max(0, from); i <= Math.min(to, all.length - 1); i++) {
      const text = all[i]!;
      const heading = headingLevel(text);
      out.push({ index: i, text, anchorText: text, heRef: null, heading, existsInDb: !(heading !== null && !stripTags(text).trim()) });
    }
    return out;
  }

  async *scan(bookKey: string, chunk: number): AsyncGenerator<LineChunk> {
    const total = (await this.load(bookKey)).length;
    for (let i = 0; i < total; i += chunk) yield { lines: await this.lines(bookKey, i, i + chunk - 1), total };
  }

  async existingLinks(): Promise<Link[]> {
    return []; // loose text files carry no links; their _links.json files are imported separately
  }

  close(): void {
    this.cache.clear();
  }

  private async load(bookKey: string): Promise<string[]> {
    const hit = this.cache.get(bookKey);
    if (hit) return hit;
    const file = this.byKey.get(bookKey);
    if (!file) throw new Error(`unknown book ${bookKey}`);
    let bytes: Uint8Array;
    try {
      bytes = await file.read();
    } catch (err) {
      // Chrome refuses to read a chosen file that was changed or deleted on disk since (NotReadableError)
      throw new LinkerError("text/unreadable", `אי אפשר לקרוא את הקובץ "${file.path}": ייתכן שהוא השתנה או נמחק אחרי שנבחר. בחרו את התיקייה או הקבצים שוב.`, { path: file.path, cause: (err as Error)?.message });
    }
    const decoded = decodeText(bytes);
    if (decoded.encoding !== "utf-8")
      this.info.warnings.push({ code: "source/not-utf8", message: `הקובץ "${file.path}" שמור בקידוד ${decoded.encoding} ולא UTF-8. הכלי מציג אותו נכון, אבל אוצריא קוראת כל ספר כ־UTF-8 — שמרו אותו מחדש ב־UTF-8 לפני שליחה לספרייה.` });
    // #41 B10: the generator breaks lines at a lone CR too, but Otzaria's import of a personal book splits at "\n" only
    // (text_book_repository.dart, range.text.split('\n')): every line_index after it would be one off there
    // the open warns about the files whose first bytes show it (registry.ts, where the store shows warnings); a CR further in
    // is caught here, once per file (V7 PR1 review, finding 4: a warning added only on read never reached the user, and repeated)
    if (/\r(?!\n)/.test(decoded.text) && !this.info.warnings.some((w) => w.code === "source/lone-cr" && w.message.includes(`"${file.path}"`)))
      this.info.warnings.push({ code: "source/lone-cr", message: loneCrMessage([file.path]) });
    const lines = splitBookLines(decoded.text);
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(bookKey, lines);
    return lines;
  }
}

function stemOf(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
