import type { BookRef } from "../core/links/model";
import { runEngine, type EngineBook, type EngineContext, type EngineId, type EngineResult } from "../linking/automatic";
import type { SourceRegistry } from "../sources/registry";

/** Reads both whole books from the registry and runs an engine on them (in the worker). */
export async function engineJob(registry: SourceRegistry, engine: EngineId, source: BookRef, target: BookRef, options: Record<string, unknown>, ctx: EngineContext): Promise<EngineResult> {
  const load = async (book: BookRef): Promise<EngineBook> => ({
    book,
    // anchorText: the line as the generator counts anchor offsets (schema 7: with footnote bodies)
    lines: (await registry.lines(book.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => ({ index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef })),
  });
  const s = await load(source);
  const t = await load(target);
  ctx.signal?.throwIfAborted();
  return runEngine(engine, s, t, options, ctx);
}
