import { guessMapping, type PendingDb } from "../../core/db-mapping";
import { LinkerError } from "../../core/errors";
import { previewSchema } from "../../database/generic/preview";
import { blobSource } from "../../database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../database/sqlite/lazy/sqlite-file";

/** How many databases may wait for a mapping at once (each holds only a File handle). */
const MAX_PENDING = 16;
let seq = 0;

/**
 * A SQLite file that is not an Otzaria database: its schema preview and an automatic guess, for
 * the mapping wizard. The file handle is kept under a token so openMapped can read it later.
 */
export async function pendingMapping(path: string, label: string, blob: Blob, pending: Map<string, { blob: Blob; label: string }>): Promise<PendingDb> {
  const file = await SqliteFile.open(blobSource(blob));
  const preview = await previewSchema(file);
  if (!preview.tables.length)
    throw new LinkerError(
      "db/no-books",
      file.header.wal
        ? // validation: an app database whose every table still sits in its -wal file (personal_notes.db)
          "בקובץ הראשי של המסד אין אף טבלה. המסד במצב WAL, ונראה שכל הנתונים שלו עדיין בקובץ ‎-wal שלידו, שהדפדפן לא יכול לקרוא. סגרו את התוכנה שמשתמשת במסד (כדי שתמזג את הקובץ) ונסו שוב."
        : "במסד אין אף טבלה שאפשר לקרוא ממנה ספרים.",
    );
  const token = `m${++seq}`;
  pending.set(token, { blob, label });
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
  return { token, path, label, preview, guess: guessMapping(preview) };
}
