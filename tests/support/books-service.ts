import { booksService } from "../../src/app/books-service";
import { SourceRegistry } from "../../src/sources/registry";
import type { BooksService } from "../../src/state/services";
import { inProcessCall, sourcesHandlers } from "../../src/workers/sources-handlers";

/**
 * The real BooksService over an in-process registry: the same handlers the worker serves and the
 * same mapping the app uses (app/books-service.ts), without postMessage. Use it instead of
 * hand-written fakes, so a test cannot drift from the worker.
 */
export function registryService(registry: SourceRegistry = new SourceRegistry()): BooksService {
  return booksService(inProcessCall(sourcesHandlers(registry)));
}
