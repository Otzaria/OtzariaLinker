import { existsSync, lstatSync, openAsBlob, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { LinkerError } from "../core/errors";
import { safeUnzip } from "../sources/archives/safe-unzip";
import type { InputFile } from "../state/services";

/*
 * A repository on disk, for the Node runner (docs/HEADLESS.md): a folder (a local git clone) or a ZIP (GitHub's "Download ZIP"),
 * offline. READ ONLY (AGENTS.md §2.3): files are opened with fs.openAsBlob, a Blob backed by the file that is read lazily, like the
 * File the browser gives the app; nothing here writes, and nothing follows a symbolic link out of the folder. Hidden folders
 * (.git, .github, .claude) and node_modules are not read.
 */
export interface RepoFiles {
  /** the folder or the ZIP, as given */
  root: string;
  kind: "folder" | "zip";
  /** relative paths, forward slashes, sorted */
  paths: string[];
  input(path: string): Promise<InputFile>;
  text(path: string): Promise<string>;
}

const SKIP_DIR = (name: string) => name.startsWith(".") || name === "node_modules";
/** what the runner reads from a ZIP: books, links files and the build's own lists */
const WANTED = /\.(txt|json|csv)$/i;

export async function openRepo(path: string): Promise<RepoFiles> {
  const root = resolve(path);
  if (!existsSync(root)) throw new LinkerError("repo/not-found", `המאגר "${path}" לא נמצא. תנו נתיב לתיקייה (עותק git מקומי) או לקובץ ZIP של המאגר.`, { path });
  return statSync(root).isDirectory() ? openFolder(root) : openZip(root);
}

function openFolder(root: string): RepoFiles {
  const paths: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // never out of the folder
      if (e.isDirectory()) {
        if (!SKIP_DIR(e.name)) walk(join(dir, e.name), r);
      } else if (e.isFile()) paths.push(r);
    }
  };
  walk(root, "");
  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const abs = (p: string) => {
    const a = resolve(root, ...p.split("/"));
    if (a !== root && !a.startsWith(root + sep)) throw new LinkerError("repo/not-found", `הנתיב "${p}" יוצא מתיקיית המאגר.`, { path: p });
    if (lstatSync(a).isSymbolicLink()) throw new LinkerError("repo/not-found", `"${p}" הוא קישור סמלי, והכלי אינו עוקב אחריו.`, { path: p });
    return a;
  };
  return {
    root,
    kind: "folder",
    paths,
    input: async (p) => ({ path: p, blob: await openAsBlob(abs(p)) }),
    text: async (p) => readFileSync(abs(p), "utf8"),
  };
}

function openZip(root: string): RepoFiles {
  const entries = safeUnzip(new Uint8Array(readFileSync(root)), { include: (p) => WANTED.test(p) });
  // GitHub wraps a repository in one folder ("zmanenu-library-main/"): paths are taken inside it
  const first = new Set(entries.map((e) => e.path.split("/")[0]));
  const strip = first.size === 1 && entries.every((e) => e.path.includes("/")) ? `${[...first][0]}/` : "";
  const files = new Map(entries.map((e) => [e.path.slice(strip.length), e.bytes]));
  for (const p of [...files.keys()]) if (p.split("/").slice(0, -1).some(SKIP_DIR)) files.delete(p);
  const get = (p: string) => {
    const b = files.get(p);
    if (!b) throw new LinkerError("repo/not-found", `"${p}" אינו בקובץ ה־ZIP.`, { path: p });
    return b;
  };
  return {
    root,
    kind: "zip",
    paths: [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    input: async (p) => ({ path: p, blob: new Blob([get(p) as Uint8Array<ArrayBuffer>]) }),
    text: async (p) => new TextDecoder().decode(get(p)),
  };
}
