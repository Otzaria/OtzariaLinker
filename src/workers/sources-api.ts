import type { SourceLine } from "../core/books";
import type { Link } from "../core/links/model";
import type { InputFile, OpenResult } from "../sources/registry";

/** The worker's operations, as the UI calls them through RpcClient. */
export interface SourcesApi {
  [op: string]: (...args: never[]) => unknown;
  /** proves sql.js and the zstd WASM start in this environment (file://, CSP) */
  ping(): { sqlite: string; zstd: string };
  open(files: InputFile[]): OpenResult;
  lines(bookKey: string, from: number, to: number): SourceLine[];
  existingLinks(bookKey: string, from: number, to: number): Link[];
  close(sourceId: string): void;
}
