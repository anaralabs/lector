import { readFile } from "node:fs/promises";
import { defineConfig, type Options } from "tsup";

// Oldest browsers that have every runtime feature the engine needs (WebGL2,
// module workers, dynamic import in workers, WASM); see src/support.ts.
export const browserTarget = ["chrome80", "edge80", "firefox114", "safari15", "ios15"];

/** Source refers to sibling `.ts` worker modules; the published files are `.js`. */
const workerUrlsToJs: NonNullable<Options["esbuildPlugins"]>[number] = {
	name: "worker-urls-to-js",
	setup(build) {
		build.onLoad({ filter: /[\\/]src[\\/]viewer\.ts$/ }, async (args) => {
			const source = await readFile(args.path, "utf8");
			const contents = source.replace(/new URL\("\.\/(raster|core)-worker\.ts", import\.meta\.url\)/g, 'new URL("./$1-worker.js", import.meta.url)');
			if (contents === source) throw new Error("worker-urls-to-js: no worker URLs found in viewer.ts");
			return { contents, loader: "ts" };
		});
	},
};

export default defineConfig({
	entry: {
		index: "src/index.ts",
		react: "src/react.tsx",
		"raster-worker": "src/raster-worker.ts",
		"core-worker": "src/core-worker.ts",
	},
	format: ["esm"],
	platform: "browser",
	target: browserTarget,
	outDir: "dist",
	clean: true,
	splitting: true,
	treeshake: true,
	sourcemap: true,
	dts: { entry: { index: "src/index.ts", react: "src/react.tsx" } },
	external: ["react", "react/jsx-runtime"],
	// The PDFium glue is bundled into the raster worker so the worker is a
	// standalone module; scripts/postbuild.mjs puts its wasm next to it in dist/.
	noExternal: ["@embedpdf/pdfium"],
	esbuildPlugins: [workerUrlsToJs],
});
