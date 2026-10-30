// Vite-only asset URLs: the PDFium wasm and the bundled worker scripts.
// Pass as `wasmUrl` / `workerUrls` (needed when assets are served cross-origin).
import core from "./core-worker.ts?worker&url";
import raster from "./raster-worker.ts?worker&url";

export { default } from "@embedpdf/pdfium/pdfium.wasm?url";
export const workerUrls = { raster, core };
