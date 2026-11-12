import { gunzipSync, strFromU8 } from "fflate";
import type { BookRef } from "./model";
import { SEFARIA_TITLES_SNAPSHOT } from "./sefaria-titles-snapshot";

/*
 * "Is this a Sefaria book" as the LIBRARY decides it (compatibility review B6). The weekly sync and
 * the PR gate classify a side by an exact title match against Sefaria's export
 * (ManualLinksRefresh.kt:482-547, primaryHeTitleCount; validate_manual_links_refs.py: the snapshot
 * `.github/data/sefaria_he_titles.txt`). The database's origin is a different question — the DB
 * stores 82 Sefaria-sourced books the snapshot does not list (לכה דודי, אקדמות מילין…), and for
 * those the gate FORBIDS ref_2. So the ref_1/ref_2 rules use this list; the generator's own gates
 * (sefaria↔sefaria skip, base books) keep using the database origin.
 *
 * The list is embedded (SEFARIA_TITLES_SNAPSHOT, with its library commit and date) and can be
 * replaced by the file itself when the user opens a library folder that has it — the opened file
 * wins, because the embedded one ages with every release of the tool.
 */
export interface SefariaTitles {
  readonly titles: ReadonlySet<string>;
  /** where the list came from, for the user: "embedded" (with its date) or the opened file's path */
  readonly source: "embedded" | "library";
  readonly label: string;
}

let embedded: SefariaTitles | undefined;

/** The list embedded at build time (decoded once). */
export function embeddedSefariaTitles(): SefariaTitles {
  if (!embedded) {
    const bin = atob(SEFARIA_TITLES_SNAPSHOT.gzipBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    embedded = {
      titles: new Set(strFromU8(gunzipSync(bytes)).split("\n")),
      source: "embedded",
      label: `רשימת ספרי ספריא של הספרייה מ־${SEFARIA_TITLES_SNAPSHOT.date} (${SEFARIA_TITLES_SNAPSHOT.commit.slice(0, 8)})`,
    };
  }
  return embedded;
}

/** The library's file as text (comments and blank lines skipped, like the gate), or null when it holds no title. */
export function parseSefariaTitles(text: string, label: string): SefariaTitles | null {
  const titles = new Set<string>();
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith("#")) titles.add(line);
  }
  return titles.size ? { titles, source: "library", label } : null;
}

/** The library file's path inside a library checkout. */
export const SEFARIA_TITLES_PATH = ".github/data/sefaria_he_titles.txt";

/** Whether the sync and the PR gate treat this book as Sefaria-owned. */
export const isSefariaOwned = (book: Pick<BookRef, "title">, list: SefariaTitles = embeddedSefariaTitles()): boolean => list.titles.has(book.title);
