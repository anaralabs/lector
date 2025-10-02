import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { styleText } from "node:util";
import { defineConfig, type Options } from "tsup";

const commonConfig = {
	format: ["esm"],
	experimentalDts: true,
	outDir: "dist",
	external: ["react", "react-dom", "pdfjs-dist"],
	splitting: true,
	treeshake: true,
	tsconfig: "tsconfig.build.json",
} satisfies Options;

const entrypoints = ["src/index.ts"];

export default defineConfig({
	...commonConfig,
	entry: entrypoints,
	async onSuccess() {
		await Promise.all(
			entrypoints.map(async (entry) => {
				const filePath = join(
					commonConfig.outDir,
					`${entry.replace(".ts", "").replace("src/", "")}.js`,
				);
				const fileContents = await readFile(filePath, "utf-8");
				const withUseClientDirective = `'use client';\n\n${fileContents}`;
				await writeFile(filePath, withUseClientDirective);
				console.info(
					[
						styleText("green", "USE"),
						styleText("bold", filePath.padEnd(29)),
						styleText("dim", 'prepended "use client"'),
					].join(" "),
				);
			}),
		);
	},
});
