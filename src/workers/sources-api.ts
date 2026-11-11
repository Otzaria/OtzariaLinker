import type { SourceLine } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import type { EngineId, EngineResult } from "../linking/automatic";
import type { InputFile, OpenResult } from "../sources/registry";
import type { BatchItem } from "./engine-job";

/** The worker's operations, as the UI calls them through RpcClient. */
export interface SourcesApi {
  [op: string]: (...args: never[]) => unknown;
  /** proves sql.js and the zstd WASM start in this environment (file://, CSP) */
  ping(): { sqlite: string; zstd: string };
  /** cheap liveness probe for the watchdog */
  alive(): true;
  open(files: InputFile[]): OpenResult;
  lines(bookKey: string, from: number, to: number): SourceLine[];
  existingLinks(bookKey: string, from: number, to: number): Link[];
  close(sourceId: string): void;
  /** runs an automatic engine on two whole books (both read here, in the worker) */
  runEngine(engine: EngineId, source: BookRef, target: BookRef, options: Record<string, unknown>): EngineResult;
  runBatch(engine: EngineId, pairs: { source: BookRef; target: BookRef }[], options: Record<string, unknown>): BatchItem[];
}
