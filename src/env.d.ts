declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILD_DATE__: string;

declare module "virtual:text-gz/*" {
  /** gzip (level 9) of the file, as base64 — build/plugins/text-gz.ts; read with unpackText */
  const packed: string;
  export default packed;
}

declare module "virtual:wasm-b64/*" {
  const base64: string;
  export default base64;
}

declare module "zstd-wasm-decoder/class" {
  export class ZstdDecoder {
    constructor(opts?: { dictionary?: Uint8Array; maxSrcSize?: number; maxDstSize?: number });
    init(module: WebAssembly.Module): ZstdDecoder;
    decompressSync(frame: Uint8Array, expectedSize?: number): Uint8Array;
  }
}
