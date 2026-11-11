import initSqlJs, { type SqlJsStatic } from "sql.js/dist/sql-wasm.js";
import wasmBase64 from "virtual:wasm-b64/sql.js/dist/sql-wasm.wasm.b64";

let instance: Promise<SqlJsStatic> | undefined;

/** sql.js with its WASM embedded in the bundle — no network, works from file://. */
export function loadSqlJs(): Promise<SqlJsStatic> {
  instance ??= initSqlJs({ wasmBinary: base64ToBytes(wasmBase64).buffer as ArrayBuffer });
  return instance;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
