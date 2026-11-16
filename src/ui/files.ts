import type { InputFile } from "../state/services";

/*
 * Turning what the user gives the browser into InputFiles with relative paths: picked files,
 * a picked folder (webkitdirectory) and drag-and-drop, where a dropped folder is walked recursively
 * through the entries API. Nothing is read here — the worker reads only the bytes it needs.
 */

const MAX_FILES = 50_000;

export function fromFileList(list: FileList | null): InputFile[] {
  return [...(list ?? [])].map((f) => ({ path: f.webkitRelativePath || f.name, blob: f }));
}

export async function fromDataTransfer(dt: DataTransfer): Promise<InputFile[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return fromFileList(dt.files);
  const out: InputFile[] = [];
  for (const e of entries) await walk(e, "", out);
  return out;
}

async function walk(entry: FileSystemEntry, prefix: string, out: InputFile[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ path, blob: file });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns at most ~100 entries per call; call until it returns none
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const child of batch) await walk(child, path, out);
  }
}

/** Opens the system file picker. `folder` picks a whole directory. */
export function pickFiles(opts: { folder?: boolean; accept?: string } = {}): Promise<InputFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (opts.folder) input.webkitdirectory = true;
    if (opts.accept) input.accept = opts.accept;
    // Firefox fires no "change" on a file input that is not in the document, so attach it (hidden)
    input.hidden = true;
    document.body.append(input);
    let settled = false;
    const done = (files: InputFile[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done(fromFileList(input.files)), { once: true });
    // Firefox can fire "cancel" BEFORE "change" for a real choice (seen with large files), so a
    // cancel never settles the pick: a real cancel simply never resolves, which callers treat as
    // "nothing chosen". The hidden input is cleaned up a while later.
    input.addEventListener("cancel", () => setTimeout(() => !settled && input.remove(), 120_000), { once: true });
    input.click();
  });
}
