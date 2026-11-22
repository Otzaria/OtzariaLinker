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

/**
 * Home: a path's card, then the task inside it (the choice moved into the wizard, issue 20), then "המשך".
 * The task ids are the old card ids; a guided task (several, folder-otzaria) then continues in the guided flow.
 */
export async function chooseTask(page: Page, path: "auto" | "repo" | "fix", task: string) {
  await page.locator(`.task-card[data-path="${path}"]`).click();
  const dlg = page.getByRole("dialog");
  await dlg.locator(`[role="radio"][data-task="${task}"]`).click();
  await dlg.getByRole("button", { name: "המשך" }).click();
}
