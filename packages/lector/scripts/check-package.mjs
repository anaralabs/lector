import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "lector-package-"));
try {
	execFileSync("pnpm", ["pack", "--pack-destination", directory], {
		// The test runs after build; do not rebuild while other tests run.
		env: { ...process.env, npm_config_ignore_scripts: "true" },
		stdio: "pipe",
	});
	const archive = (await readdir(directory)).find(name => name.endsWith(".tgz"));
	assert.ok(archive, "pnpm must produce a package archive");
	execFileSync("tar", ["-xzf", join(directory, archive), "-C", directory]);
	const packed = join(directory, "package");
	const manifest = JSON.parse(await readFile(join(packed, "package.json"), "utf8"));
	for (const target of Object.values(manifest.exports["."])) {
		await readFile(join(packed, target));
	}
	// Resolve the published artifact by package name, with its real peer deps.
	await mkdir(join(directory, "node_modules", "@anaralabs"), { recursive: true });
	await symlink(packed, join(directory, "node_modules", "@anaralabs", "lector"));
	await symlink(resolve("node_modules"), join(packed, "node_modules"));
	const require = createRequire(join(directory, "consumer.cjs"));
	assert.throws(() => require("@anaralabs/lector"), /@anaralabs\/lector is ESM only/);
	const library = await import(pathToFileURL(join(packed, manifest.exports["."].import)).href);
	const { createElement } = require(join(packed, "node_modules", "react"));
	const { renderToString } = require(join(packed, "node_modules", "react-dom", "server.node.js"));
	const html = renderToString(createElement(library.Root, { source: "test.pdf" }, "Loading"));
	assert.equal(typeof html, "string");
	assert.equal(typeof library.useSearch, "function");
	assert.equal(typeof library.usePdfSelection, "function");
	assert.equal(typeof library.usePageAnnotations, "function");
	console.info("Packed exports, CommonJS diagnostic, ESM import and server rendering passed.");
} finally {
	await rm(directory, { recursive: true, force: true });
}
