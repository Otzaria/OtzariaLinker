import type { SourceBook, SourceInfo, SourceLine } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import type { EngineId, EngineResult } from "../linking/automatic";

/*
 * What the state layer needs from the outside world, as interfaces (architecture rule 17). The app
 * wires the real worker client in; tests pass an in-memory fake. Shapes match src/sources/registry
 * structurally, without importing it (state may not depend on sources).
 */
export interface InputFile {
  path: string;
  blob: Blob;
}

export interface OpenedSource {
  info: SourceInfo;
  books: SourceBook[];
}

export interface OpenResult {
  sources: OpenedSource[];
  documents: { path: string; kind: "links-json" | "project"; text: string }[];
  skipped: { path: string; reason: string }[];
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface BooksService {
  open(files: InputFile[], opts?: CallOptions): Promise<OpenResult>;
  lines(bookKey: string, from: number, to: number, opts?: CallOptions): Promise<SourceLine[]>;
  existingLinks(bookKey: string, from: number, to: number, opts?: CallOptions): Promise<Link[]>;
  close(sourceId: string): Promise<void>;
  runEngine(engine: EngineId, source: BookRef, target: BookRef, options: Record<string, unknown>, opts?: CallOptions): Promise<EngineResult>;
}

/** Where a file the program makes goes (a download in the browser). */
export interface Saver {
  save(name: string, data: Uint8Array | string, mime: string): void;
}
