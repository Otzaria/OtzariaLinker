import { fstatSync, openSync, readSync } from "node:fs";

/*
 * A read-only, Blob-shaped view of a file on disk for Node tests: size and slice().arrayBuffer() read
 * through a file descriptor opened "r". (Node's fs.openAsBlob reports a wrong size for files over 4 GiB,
 * and seforim.db is 4.5 GB.) Only what blobSource / detectKind use is implemented.
 */
export function fileBlob(path: string): Blob {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  const slice = (from = 0, to = size) => {
    const a = Math.max(0, Math.min(size, from));
    const b = Math.max(a, Math.min(size, to));
    return {
      size: b - a,
      async arrayBuffer(): Promise<ArrayBuffer> {
        const buf = new Uint8Array(b - a);
        let done = 0;
        while (done < buf.length) {
          const n = readSync(fd, buf, done, buf.length - done, a + done);
          if (n <= 0) break;
          done += n;
        }
        return buf.buffer;
      },
    };
  };
  return { size, type: "", slice } as unknown as Blob;
}
