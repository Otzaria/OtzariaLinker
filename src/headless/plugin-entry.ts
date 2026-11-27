import { CORE_API_VERSION, createLinkerCore, engineSummaries, type LinkerCore } from "./core";
import { otzariaAdapters, otzariaBookKey, SDK_LIMITS, type OtzariaCall, type OtzariaHostOptions } from "./otzaria-host";

/*
 * The entry of the plugin package (`npm run build:plugin` → dist-plugin/otzaria-linker-core.js, vite.plugin.config.ts): ONE classic
 * script, no `import` (Otzaria loads a headless plugin on Linux and Android as a plain script from file://, where modules are
 * blocked — plugin-sdk README "תוסף ללא ממשק"). It defines the global `OtzariaLinkerCore` and nothing else; it calls nothing
 * on load. It is NOT part of dist/OtzariaLinker.html (that build has its own entry, index.html → src/app/main.tsx).
 */
export interface ForOtzariaOptions extends Omit<OtzariaHostOptions, "books"> {
  books: readonly string[];
  progress?: (done: number, total: number) => void;
  cancel?: AbortSignal;
  /** the host function; default: the `Otzaria.call` the SDK injects into the plugin's page */
  call?: OtzariaCall;
}

/** The core over Otzaria's plugin API in one call: what a plugin's main.js does first. */
export function forOtzaria(opts: ForOtzariaOptions): LinkerCore {
  const injected = (globalThis as { Otzaria?: { call?: OtzariaCall } }).Otzaria;
  const call = opts.call ?? (injected?.call ? (m: string, p?: Record<string, unknown>) => injected.call!(m, p) : undefined);
  if (!call) throw new Error("Otzaria.call is not available: run inside an Otzaria plugin, or pass `call`.");
  return createLinkerCore(otzariaAdapters(call, opts));
}

export { CORE_API_VERSION as version, createLinkerCore, engineSummaries as engines, otzariaAdapters, otzariaBookKey, SDK_LIMITS };
