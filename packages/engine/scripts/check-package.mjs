// Packs the package and checks that every export points at a packed file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "lector-engine-package-"));
try {
	execFileSync("pnpm", ["pack", "--pack-destination", directory], {
		env: { ...process.env, npm_config_ignore_scripts: "true" },
		stdio: "pipe",
	});
	const archive = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
	assert.ok(archive, "pnpm must produce a package archive");
	execFileSync("tar", ["-xzf", join(directory, archive), "-C", directory]);
	const packed = join(directory, "package");
	const manifest = JSON.parse(await readFile(join(packed, "package.json"), "utf8"));
	assert.equal(manifest.private, undefined, "package must not be private");
	const targets = Object.values(manifest.exports).flatMap((t) => (typeof t === "string" ? [t] : Object.values(t)));
	for (const target of targets) await stat(join(packed, target));
	// Worker URLs in the viewer must point at the published .js files.
	const chunks = (await readdir(join(packed, "dist"))).filter((f) => f.endsWith(".js"));
	const code = (await Promise.all(chunks.map((f) => readFile(join(packed, "dist", f), "utf8")))).join("\n");
	assert.match(code, /new URL\("\.\/raster-worker\.js", import\.meta\.url\)/);
	assert.match(code, /new URL\("\.\/core-worker\.js", import\.meta\.url\)/);
	assert.doesNotMatch(code, /"\.\/(raster|core)-worker\.ts"/);
	const { size } = await stat(join(packed, "dist/pdfium.wasm"));
	assert.ok(size > 1_000_000, "pdfium.wasm must be packed");
	console.info(`Packed ${targets.length} export targets; worker URLs and pdfium.wasm OK.`);
} finally {
	await rm(directory, { recursive: true, force: true });
}
