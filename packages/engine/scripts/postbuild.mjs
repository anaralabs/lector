// Runs after tsup (not in its onSuccess, which races the d.ts build's clean).
import { copyFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// The bundled PDFium glue resolves `new URL("pdfium.wasm", import.meta.url)`,
// and vite-wasm.js imports it, so it lives next to raster-worker.js.
await copyFile(require.resolve("@embedpdf/pdfium/pdfium.wasm"), "dist/pdfium.wasm");

// Vite-only asset URLs. Not bundled by tsup: the consumer's Vite resolves these
// queries and emits the workers and the wasm as same-origin assets.
await writeFile(
	"dist/vite-wasm.js",
	`// Vite-only asset URLs: the PDFium wasm and the bundled worker scripts.
// Pass as \`wasmUrl\` / \`workerUrls\` to createViewer or <LectorView>.
import core from "./core-worker.js?worker&url";
import raster from "./raster-worker.js?worker&url";

export { default } from "./pdfium.wasm?url";
export const workerUrls = { raster, core };
`,
);
await writeFile(
	"dist/vite-wasm.d.ts",
	`/** URL of the PDFium wasm, emitted by Vite as a same-origin asset. */
declare const wasmUrl: string;
export default wasmUrl;
/** URLs of the engine's worker scripts, bundled by Vite. */
export declare const workerUrls: { raster: string; core: string };
`,
);
console.info("postbuild: dist/pdfium.wasm, dist/vite-wasm.js, dist/vite-wasm.d.ts");
