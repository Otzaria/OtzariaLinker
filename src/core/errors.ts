/**
 * Every failure the user can see carries a stable code (for logs, tests and the troubleshooting
 * guide) and a Hebrew message that says what happened AND what to do.
 */
export type ErrorCode =
  | "archive/unsafe-path"
  | "archive/duplicate-path"
  | "export/unsafe-path"
  | "export/library-record-dropped"
  | "export/accounting"
  | "archive/too-many-entries"
  | "archive/too-large"
  | "archive/suspicious-ratio"
  | "archive/corrupt"
  | "archive/unsupported-compression"
  | "text/undecodable"
  | "text/unreadable"
  | "db/value-not-text"
  | "db/compressed-corrupt"
  | "db/book-too-large"
  | "db/compressed-unknown-dictionary"
  | "db/dictionary-conflict"
  | "db/dictionary-mismatch"
  | "db/dictionary-too-large"
  | "db/not-sqlite"
  | "db/wal"
  | "db/no-books"
  | "db/schema-newer"
  /** a warning, not thrown: user_books.db's user_link exists but is in a layout the reader does not know (user-links-reader.ts) */
  | "db/user-link-not-read"
  | "source/closed"
  | "db/mapping-invalid"
  | "db/mapping-unknown-token"
  | "db/corrupt"
  /** the headless core and the Otzaria plugin host (headless/, docs/PLUGIN_READINESS.md) */
  | "plugin/host-error"
  | "plugin/unknown-book"
  | "plugin/bad-content"
  | "plugin/bad-file-name"
  | "plugin/file-too-large"
  /** the folder-repository runner (cli/, docs/HEADLESS.md) */
  | "repo/not-found"
  | "repo/unsafe-out"
  | "repo/exists"
  | "repo/bad-args"
  | "repo/unreadable";

export class LinkerError extends Error {
  override readonly name = "LinkerError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}
