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
  const preview = await previewSchema(await SqliteFile.open(blobSource(blob)));
  if (!preview.tables.length) throw new LinkerError("db/no-books", "במסד אין אף טבלה שאפשר לקרוא ממנה ספרים.");
  const token = `m${++seq}`;
  pending.set(token, { blob, label });
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
  return { token, path, label, preview, guess: guessMapping(preview) };
}
