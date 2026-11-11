import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";

export const distUrl = pathToFileURL(resolve("dist/OtzariaLinker.html")).href;
export const legacyUrl = pathToFileURL(resolve("legacy/OtzariaLinker-v3.html")).href;

/** Records every request that is not file:/data:/blob: and every uncaught page error. */
export function watchPage(page: Page) {
  const external: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => { if (!/^(file|data|blob):/.test(r.url())) external.push(r.url()); });
  page.on("pageerror", (e) => errors.push(e.message));
  return { external, errors };
}
