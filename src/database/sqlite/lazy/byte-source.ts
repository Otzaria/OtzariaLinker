/**
 * Random-access bytes of a database file. A `File` is read with `slice()`, so a multi-GB
 * seforim.db is never loaded whole — only the pages a query touches (works inside a Worker).
 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset, length) {
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
  };
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    },
  };
}
