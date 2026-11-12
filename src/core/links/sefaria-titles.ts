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

/** The library file's path inside a library checkout (the constant lives where the worker can read it). */
export { SEFARIA_TITLES_PATH } from "./sefaria-owned";

/*
 * THE rule for "is this a Sefaria book" (compatibility review B6, product audit F2) — the one place it
 * lives; AppStore.isSefariaOwned applies it to what is open, and the engines get its answer
 * (core/links/sefaria-owned.ts). The Sefaria constraints (ref_1/ref_2, no anchor end, no anchor into
 * Sefaria, no range on a Sefaria side) are rules of the LIBRARY'S weekly sync, so they bind the
 * library's own books:
 *
 *   - the title is in the library's list of Sefaria titles (above), AND
 *   - the book in hand is the library's edition of it (`edition`):
 *       true      — the official Otzaria database, a library checkout (a folder holding
 *                   .github/data/sefaria_he_titles.txt), or any source the user marked "ספרי ספריית
 *                   אוצריא" in the sources list (AppStore.setLibrarySource);
 *       false     — the user's own book that only shares the name: a text file, a personal database
 *                   (one in the Otzaria schema without the library's Sefaria books, F12), a mapped one;
 *       undefined — no book of that name is open (a links file names it): the name means the library's
 *                   book, as it does for the sync.
 *
 * Whether a text file named "בראשית" is a copy of the library's book or the user's own is genuinely
 * ambiguous, so it is never guessed from the name: it defaults to "the user's", and one switch per
 * source says otherwise. A link sent to the library that touches such a book is still refused — by
 * validate.ts sefaria/not-library-edition, in plain words — because the library would read the name as
 * its Sefaria book.
 */
export const isSefariaOwned = (book: Pick<BookRef, "title">, list: SefariaTitles = embeddedSefariaTitles(), edition?: boolean): boolean => edition !== false && list.titles.has(book.title);

/** The library gives this name to a Sefaria book, whatever book of that name is open. */
export const hasSefariaTitle = (book: Pick<BookRef, "title">, list: SefariaTitles = embeddedSefariaTitles()): boolean => list.titles.has(book.title);
