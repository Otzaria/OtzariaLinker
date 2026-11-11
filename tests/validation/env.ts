import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openAsBlob, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DbLinkRow } from "../../src/database/otzaria/links-reader";
import type { ByteSource } from "../../src/database/sqlite/lazy/byte-source";

/*
 * Shared plumbing of the real-data validation (docs/validation/REAL_DATA_REPORT.md).
 *
 *   OTZARIA_DB         the current seforim.db (opened read-only, never written)
 *   OTZARIA_LIBRARY    a clone of Otzaria/otzaria-library (read-only)
 *   OTZARIA_EXTRA_DBS  other SQLite files, separated by ";" (read-only)
 *   VALIDATION_OUT     optional folder for the JSON results each check writes (for the report)
 *   PYTHON             optional interpreter for the oracle (default: "py -3 -I" on Windows, "python3 -I")
 *
 * The oracle (scripts/validation/db_oracle.py) is Python's sqlite3 + libzstd: an independent reader
 * the tool's lazy page reader is compared with. Its output goes to a temporary folder that is
 * removed when the run ends.
 */
export const DB = process.env.OTZARIA_DB || undefined;
export const LIBRARY = process.env.OTZARIA_LIBRARY || undefined;
export const EXTRA_DBS = (process.env.OTZARIA_EXTRA_DBS ?? "").split(";").map((s) => s.trim()).filter(Boolean);
const OUT = process.env.VALIDATION_OUT || undefined;

/** A file as random-access bytes, read with readSync on a descriptor opened "r". */
export function fileSource(path: string): { source: ByteSource; close: () => void } {
  const fd = openSync(path, "r");
  return {
    source: {
      size: fstatSync(fd).size,
      async read(offset, length) {
        const buf = new Uint8Array(length);
        return buf.subarray(0, readSync(fd, buf, 0, length, offset));
      },
    },
    close: () => closeSync(fd),
  };
}

/**
 * A file as a Blob, read lazily like a browser File — so the registry and blobSource take the exact
 * path the app takes. Not fs.openAsBlob: in Node 24.19 on Windows it reports the size of a file over
 * 4 GiB modulo 2^32 (seforim.db, 4,492,886,016 bytes → 197,918,720) and every slice past that is
 * empty. Measured 2026-11-11; see REAL_DATA_REPORT.md.
 */
export async function fileBlob(path: string): Promise<Blob> {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  const slice = (start = 0, end = size): Blob => {
    const from = Math.max(0, Math.min(start, size));
    const to = Math.max(from, Math.min(end, size));
    const part = {
      size: to - from,
      type: "",
      async arrayBuffer() {
        const buf = new Uint8Array(to - from);
        let done = 0;
        while (done < buf.length) {
          const n = readSync(fd, buf, done, buf.length - done, from + done);
          if (!n) break;
          done += n;
        }
        return buf.buffer;
      },
      slice: (s = 0, e = to - from) => slice(from + s, from + Math.min(e, to - from)),
    };
    return part as unknown as Blob;
  };
  return slice();
}

/** Node's own file Blob — kept to document the >4 GiB size bug above. */
export const nodeFileBlob = (path: string): Promise<Blob> => openAsBlob(path);

let tmp: string | null = null;
/** A per-run temporary folder (removed by cleanupTmp). */
export function tmpDir(): string {
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), "otzaria-linker-validate-"));
  return tmp;
}
export function cleanupTmp(): void {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
}

function python(): [string, string[]] {
  if (process.env.PYTHON) {
    const [cmd, ...args] = process.env.PYTHON.split(" ");
    return [cmd!, args];
  }
  return process.platform === "win32" ? ["py", ["-3", "-I"]] : ["python3", ["-I"]];
}

/** Runs one oracle command against OTZARIA_DB; returns the path of its output file. */
export function oracle(cmd: string, outName: string, ...args: string[]): string {
  const out = join(tmpDir(), outName);
  const [py, pre] = python();
  const r = spawnSync(py, [...pre, resolve("scripts/validation/db_oracle.py"), cmd, DB!, out, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`oracle ${cmd} failed (${r.status}): ${r.stderr || r.error}`);
  return out;
}

/** 12 hex chars of SHA-1 over UTF-8 — the same as h() in db_oracle.py; "-" for null. */
export function h(s: string | null | undefined): string {
  if (s === null || s === undefined) return "-";
  return createHash("sha1").update(s, "utf8").digest("hex").slice(0, 12);
}

/** One DB link as a string, identical to canonical() in db_oracle.py. */
export function canonicalRow(r: DbLinkRow): string {
  const e = (x: number | undefined) => (x === undefined ? "" : String(x));
  const anchors = r.anchors.map((a) => `${a.side}:${a.charStart}:${a.charEnd ?? ""}:${a.label ?? ""}`).join(";");
  return `${r.id}|${r.typeName}|${r.source.bookId}:${r.source.lineIndex}:${e(r.source.endIndex)}|${r.target.bookId}:${r.target.lineIndex}:${e(r.target.endIndex)}|${anchors}|${[...r.suppressedSides].sort().join(",")}`;
}

export interface GitFile {
  path: string;
  sha: string;
  size: number;
}

/**
 * Files of the library clone AS COMMITTED (HEAD), not as checked out: with core.autocrlf=true (the
 * clone on this machine) the working tree has CRLF everywhere, while the repository — and so the
 * generator and the weekly pipeline — have LF.
 */
export function gitFiles(repo: string, match: (path: string) => boolean): GitFile[] {
  const r = spawnSync("git", ["-C", repo, "-c", "core.quotepath=off", "ls-tree", "-r", "-l", "-z", "HEAD"], { maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-tree failed: ${r.stderr}`);
  const out: GitFile[] = [];
  for (const entry of r.stdout.toString("utf8").split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [, type, sha, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
    if (type === "blob" && match(path)) out.push({ path, sha: sha!, size: Number(size) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Reads committed blobs in batches (`git cat-file --batch`, ~64 MB per call). */
export function* gitBlobs(repo: string, files: readonly GitFile[]): Generator<[GitFile, Buffer]> {
  for (let i = 0; i < files.length; ) {
    const batch: GitFile[] = [];
    let bytes = 0;
    while (i < files.length && (batch.length === 0 || bytes + files[i]!.size < 64 * 1024 * 1024)) {
      bytes += files[i]!.size;
      batch.push(files[i++]!);
    }
    const r = spawnSync("git", ["-C", repo, "cat-file", "--batch"], { input: batch.map((f) => f.sha).join("\n") + "\n", maxBuffer: bytes + batch.length * 128 + 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git cat-file failed: ${r.stderr}`);
    const buf = r.stdout;
    let at = 0;
    for (const f of batch) {
      const nl = buf.indexOf(10, at);
      const size = Number(buf.subarray(at, nl).toString("latin1").split(" ")[2]);
      yield [f, buf.subarray(nl + 1, nl + 1 + size)];
      at = nl + 1 + size + 1;
    }
  }
}

/** The library's commit (for the report). */
export function gitHead(repo: string): string {
  return spawnSync("git", ["-C", repo, "log", "-1", "--format=%H %cI"], { encoding: "utf8" }).stdout.trim();
}

/** size + mtime of a file — taken before and after a check to show it was not written. */
export function fingerprint(path: string): string {
  const s = statSync(path);
  return `${s.size}@${s.mtimeMs}`;
}

/** Writes a check's results to VALIDATION_OUT/<name>.json (when set) and returns them. */
export function record<T>(name: string, data: T): T {
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, null, 2));
  }
  return data;
}

export const ms = (t0: number): number => Math.round(performance.now() - t0);

/** Counts by key, sorted by count. */
export function tally(keys: Iterable<string>): Record<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
}
