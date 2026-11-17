// Runs after tsup (not in its onSuccess, which races the d.ts build's clean).
import { execFileSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

// The PDFium wasm trimmed to the functions the engine calls (scripts/pdfium.mjs).
// vite-wasm.js imports it, so it lives next to raster-worker.js.
await copyFile("src/pdfium/pdfium.wasm", "dist/pdfium.wasm");

// The same PDFium as plain JS (Binaryen wasm2js) for browsers with WebAssembly off, e.g. Safari's Lockdown Mode.
// The raster worker imports it and calls asmFunc with the glue's imports, as instantiating the wasm would.
const wasm2js = join(dirname(require.resolve("binaryen/package.json")), "bin/wasm2js");
const asm = execFileSync(process.execPath, [wasm2js, "dist/pdfium.wasm", "--mvp-features", "--enable-sign-ext", "--enable-mutable-globals", "-O2"], { maxBuffer: 1 << 30 }).toString();
const tail = asm.indexOf("\nvar retasmFunc = asmFunc(");
if (tail < 0 || !asm.includes("function asmFunc(imports)")) throw new Error("postbuild: unexpected wasm2js output");
await writeFile("dist/pdfium.asm.js", `${asm.slice(0, tail).replace(/^import \* as \w+ from '[\w-]+';\n/gm, "")}\nexport { asmFunc };\n`);
// PDFium's binary and EmbedPDF's glue ship under their own licenses (see THIRD_PARTY_NOTICES.md).
const pdfiumDir = dirname(dirname(require.resolve("@embedpdf/pdfium/pdfium.wasm")));
await copyFile(join(pdfiumDir, "LICENSE.pdfium"), "dist/LICENSE.pdfium");
await copyFile(join(pdfiumDir, "LICENSE"), "dist/LICENSE.embedpdf");

// Vite-only asset URLs. Not bundled by tsup: the consumer's Vite resolves these
// queries and emits the workers and the wasm as same-origin assets.
await writeFile(
	"dist/vite-wasm.js",
	`// Vite-only asset URLs: the PDFium wasm and the bundled worker scripts.
// Pass as \`wasmUrl\` / \`workerUrls\` to createViewer or <LectorView>.
import core from "./core-worker.js?worker&url";
import raster from "./raster-worker.js?worker&url";

export { default } from "./pdfium.wasm?url";
export { default as pdfiumJsUrl } from "./pdfium.asm.js?url";
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
/** URL of PDFium compiled to plain JS, for browsers with WebAssembly off. */
export declare const pdfiumJsUrl: string;
`,
);
// esbuild drops module directives when bundling; React Server Components need
// the client boundary on the react entry.
const react = await readFile("dist/react.js", "utf8");
if (!react.startsWith('"use client"')) await writeFile("dist/react.js", `"use client";\n${react}`);

console.info("postbuild: dist/pdfium.wasm, dist/pdfium.asm.js, dist/LICENSE.pdfium, dist/LICENSE.embedpdf, dist/vite-wasm.js, dist/vite-wasm.d.ts");
