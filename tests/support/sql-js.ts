import { createRequire } from "node:module";
import initSqlJs, { type SqlJsStatic } from "sql.js";

const require = createRequire(import.meta.url);

/** The config `initSqlJs` takes, as the installed @types/sql.js declares it. */
type SqlJsConfig = NonNullable<Parameters<typeof initSqlJs>[0]>;

/**
 * sql.js for tests: the standalone SQLite writer that builds fixtures (AGENTS.md §2.3; it is never in
 * the product). Every test starts it here, so the config is written once.
 *
 * Why the assertion: @types/sql.js 1.4.x declares the config as `Partial<EmscriptenModule>`, and
 * 1.16.0 (Dependabot #35, with sql.js 1.17.0) adds a REQUIRED `useOldExtensionFunctions`. An object
 * literal cannot satisfy both: without the field it fails 1.16's type, and with it 1.4's excess
 * property check. The assertion leaves the field out, so sql.js keeps its own default (`true`) under
 * either version. The WASM is resolved from the installed package
 * (sql.js 1.17.0 exports `./dist/*`, so the path stays resolvable).
 */
export function loadSqlJs(): Promise<SqlJsStatic> {
  const config: Partial<SqlJsConfig> = { locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`) };
  return initSqlJs(config as SqlJsConfig);
}
