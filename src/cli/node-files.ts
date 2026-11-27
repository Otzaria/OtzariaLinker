import { closeSync, existsSync, fstatSync, lstatSync, openAsBlob, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
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

/**
 * A file as a Blob read lazily through a descriptor opened "r" (readSync at each slice), like the File the browser gives the app.
 * NOT fs.openAsBlob for the database: in Node 24 on Windows it reports the size of a file over 4 GiB modulo 2^32 and every slice
 * past that is empty — the official seforim.db (4,769,005,568 bytes) came out as 474,038,272 bytes and "damaged" (V7 round 2,
 * item 8: found on the first run against the real database; the same bug tests/validation/env.ts fileBlob works around).
 * `close` releases the descriptor; reading after it fails.
 */
export function fileBlob(path: string): { blob: Blob; close: () => void } {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  const part = (from: number, to: number): Blob => {
    const read = (): Uint8Array<ArrayBuffer> => {
      const buf = new Uint8Array(to - from);
      let done = 0;
      while (done < buf.length) {
        const n = readSync(fd, buf, done, buf.length - done, from + done);
        if (!n) break;
        done += n;
      }
      return done === buf.length ? buf : buf.slice(0, done);
    };
    const blob = {
      size: to - from,
      type: "",
      arrayBuffer: async () => read().buffer,
      bytes: async () => read(),
      text: async () => new TextDecoder().decode(read()),
      stream: () => new Blob([read()]).stream(),
      // Blob.slice semantics: negative positions count from the end, and the range is clamped
      slice: (start = 0, end = to - from) => {
        const len = to - from;
        const at = (v: number) => Math.max(0, Math.min(len, v < 0 ? len + v : v));
        const s = at(start);
        return part(from + s, from + Math.max(s, at(end)));
      },
    };
    return blob as unknown as Blob;
  };
  return { blob: part(0, size), close: () => closeSync(fd) };
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
