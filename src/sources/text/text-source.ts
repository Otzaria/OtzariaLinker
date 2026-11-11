import type { Link } from "../../core/links/model";
import { otzariaBookTitle } from "../../core/links/titles";
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
      titles.set(t, [...(titles.get(t) ?? []), f.path]);
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
    const decoded = decodeText(await file.read());
    if (decoded.encoding !== "utf-8")
      this.info.warnings.push({ code: "source/not-utf8", message: `הקובץ "${file.path}" שמור בקידוד ${decoded.encoding} ולא UTF-8. הכלי מציג אותו נכון, אבל הגנרטור של אוצריא קורא כל ספר כ־UTF-8 — שמרו אותו מחדש ב־UTF-8 לפני שליחה לספרייה.` });
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
