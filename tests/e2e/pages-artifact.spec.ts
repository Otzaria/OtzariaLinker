import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

/*
 * The "download the tool for offline use" button against the real Pages artifact, not a routed fake (PR 3 fix round).
 * `_site` is made the way .github/workflows/pages.yml makes it: the `cp` lines of its "The site" step are read from the
 * workflow and run here against dist/, so the test cannot drift from the workflow. It is then served over real http
 * (localhost) and the page's own relative link is followed. What it proves: the file the button points at exists in the
 * artifact, is the BUILT html (the inlined app, not Vite's source entry), has the SHA-256 that the artifact's SHA256SUMS
 * names, and is byte for byte what the build produced. It does NOT prove the live site (needs a real deploy) and does
 * not touch releases/latest/download (404 until a stable 4.x release exists, on purpose).
 */
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function siteFromWorkflow(root: string): string {
  const yml = readFileSync(".github/workflows/pages.yml", "utf8");
  const step = yml.slice(yml.indexOf("- name: The site"), yml.indexOf("- uses: actions/upload-pages-artifact"));
  const cps = [...step.matchAll(/^\s*cp (\S+) (\S+)\s*$/gm)].map((m) => [m[1]!, m[2]!] as const);
  expect(cps.length, "the cp lines of the Pages step").toBeGreaterThanOrEqual(3);
  for (const [from, to] of cps) {
    expect(existsSync(from), `${from} (a cp source of pages.yml) exists after the build`).toBe(true);
    // the workflow copies into `_site/…`; here `root` is that directory
    expect(to.startsWith("_site/"), `${to} is inside _site`).toBe(true);
    const dest = join(root, to.slice("_site/".length));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(from, dest);
  }
  return root;
}

function serve(root: string): Promise<{ server: Server; origin: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    asked.push(path);
    const file = join(root, path === "/" ? "index.html" : path);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, asked })));
}

test("the button's target exists in the Pages artifact, is the built html with the published SHA-256, and downloads byte for byte", async ({ browser }, info) => {
  const root = resolve(info.outputPath(), "_site");
  mkdirSync(root, { recursive: true });
  siteFromWorkflow(root);
  const built = readFileSync("dist/OtzariaLinker.html");

  // the artifact's files: the page, the offered file and its hash line
  for (const f of ["index.html", "OtzariaLinker.html", "SHA256SUMS"]) expect(existsSync(join(root, f)), `_site/${f}`).toBe(true);
  const offered = readFileSync(join(root, "OtzariaLinker.html"));
  expect(offered.equals(built), "the offered file is what the build produced").toBe(true);
  expect(readFileSync(join(root, "index.html")).equals(built)).toBe(true);
  // built, not source: the app is inlined, Vite's dev entry is not referenced, and there is no external script
  const text = offered.toString("utf8");
  expect(text.toLowerCase().startsWith("<!doctype html")).toBe(true);
  expect(text).not.toContain("/src/app/main.tsx");
  expect(text).not.toMatch(/<script[^>]*\ssrc=["'](?!data:|blob:)/i);
  expect(text.length).toBeGreaterThan(500_000);
  // the hash the artifact publishes is the hash of the offered file
  const line = readFileSync(join(root, "SHA256SUMS"), "utf8").split(/\r?\n/).find((l) => l.endsWith("OtzariaLinker.html") && !/OtzariaLinker-/.test(l));
  expect(line, "SHA256SUMS has a line for OtzariaLinker.html").toBeTruthy();
  expect(line!.split(/\s+/)[0]).toBe(sha256(offered));

  // the real page, served over http: the relative link resolves to that file and the browser downloads exactly it
  const { server, origin, asked } = await serve(root);
  const ctx = await browser.newContext({ locale: "he-IL", offline: false, acceptDownloads: true });
  const stray: string[] = [];
  const errors: string[] = [];
  try {
    const page = await ctx.newPage();
    page.on("request", (r) => {
      if (!r.url().startsWith(origin) && !/^(data|blob):/.test(r.url())) stray.push(r.url());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/`);
    await expect(page.getByRole("heading", { name: "מה תרצו לעשות?" })).toBeVisible();
    const link = page.getByRole("link", { name: /הורדת הכלי/ });
    await expect(link).toBeVisible();
    expect(await link.evaluate((a) => (a as HTMLAnchorElement).href)).toBe(`${origin}/OtzariaLinker.html`);
    const download = page.waitForEvent("download");
    await link.click();
    const d = await download;
    expect(d.suggestedFilename()).toBe("OtzariaLinker.html");
    const saved = resolve(info.outputPath(), "downloaded.html");
    await d.saveAs(saved);
    const got = readFileSync(saved);
    expect(sha256(got)).toBe(sha256(built));
    expect(asked).toContain("/OtzariaLinker.html");
    expect(stray).toEqual([]);
    expect(errors).toEqual([]);
    writeFileSync(resolve(info.outputPath(), "sha256.txt"), `${sha256(got)}  OtzariaLinker.html (${got.length} bytes)\n`);
  } finally {
    await ctx.close();
    server.close();
  }
});
