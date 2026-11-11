/**
 * Every failure the user can see carries a stable code (for logs, tests and the troubleshooting
 * guide) and a Hebrew message that says what happened AND what to do.
 */
export type ErrorCode =
  | "archive/unsafe-path"
  | "archive/too-many-entries"
  | "archive/too-large"
  | "archive/suspicious-ratio"
  | "archive/corrupt"
  | "archive/unsupported-compression"
  | "text/undecodable"
  | "db/value-not-text"
  | "db/compressed-corrupt"
  | "db/compressed-unknown-dictionary"
  | "db/dictionary-conflict"
  | "db/dictionary-too-large"
  | "db/not-sqlite"
  | "db/wal"
  | "db/no-books"
  | "db/schema-newer"
  | "source/closed";

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
