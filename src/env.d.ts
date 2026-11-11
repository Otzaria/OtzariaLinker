declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILD_DATE__: string;

declare module "virtual:wasm-b64/*" {
  const base64: string;
  export default base64;
}
