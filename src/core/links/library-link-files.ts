import { gunzipSync, strFromU8 } from "fflate";
import { LIBRARY_LINK_FILES_SNAPSHOT } from "./library-link-files-snapshot";

/*
 * Which books Otzaria/otzaria-library holds a `<title>_links.json` for (names only, scripts/library-link-files-snapshot.mjs).
 * A links file REPLACES the book's file in the library, and the database's `hasSourceLinks` mark is wide (it counts
 * Sefaria's and automatic links, LINK_FORMATS §4.5), so the export's hold on "this book may have a file" says, from this
 * list, whether the library does have one. The list ages with every release of the tool: it only words the message and
 * adds a hold for a listed book; it never lifts the hold the database mark raises.
 */
export interface LibraryLinkFiles {
  readonly titles: ReadonlySet<string>;
  /** for the user: which list this is and from when */
  readonly label: string;
}

let embedded: LibraryLinkFiles | undefined;

export function embeddedLibraryLinkFiles(): LibraryLinkFiles {
  if (!embedded) {
    const bin = atob(LIBRARY_LINK_FILES_SNAPSHOT.gzipBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    embedded = {
      titles: new Set(strFromU8(gunzipSync(bytes)).split("\n")),
      label: `רשימת קובצי הקישורים של הספרייה מ־${LIBRARY_LINK_FILES_SNAPSHOT.date} (${LIBRARY_LINK_FILES_SNAPSHOT.commit.slice(0, 8)})`,
    };
  }
  return embedded;
}
