// Loads both release configs through semantic-release's own config loader, exactly as
// CI runs it (cwd packages/<name>, --extends ../../scripts/release/<name>.mjs), so a
// plugin that cannot be resolved fails here instead of on main.
// node --test scripts/release/config.test.mjs (needs the root install: semantic-release)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const STEPS = ["verifyConditions", "analyzeCommits", "generateNotes", "prepare", "publish", "addChannel", "success", "fail"];

for (const name of ["lector", "engine"]) {
	test(`${name} release config loads every plugin`, async () => {
		const require = createRequire(join(root, "package.json"));
		const lib = dirname(require.resolve("semantic-release"));
		const { default: getConfig } = await import(pathToFileURL(join(lib, "lib/get-config.js")).href);
		const logs = [];
		const logger = { log: (...a) => logs.push(a.join(" ")), success: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), warn() {} };
		const cwd = join(root, "packages", name);
		const { options, plugins } = await getConfig({ cwd, env: {}, logger, stdout: process.stdout, stderr: process.stderr }, { extends: `../../scripts/release/${name}.mjs` });
		assert.equal(options.tagFormat, name === "lector" ? "v${version}" : "lector-engine-v${version}");
		for (const step of STEPS) assert.equal(typeof plugins[step], "function", `${step} loaded`);
		// The npm and GitHub steps are ours (wrappers) and the analyser filters by path.
		const loaded = logs.join("\n");
		for (const file of ["commits.mjs", "npm.mjs", "github.mjs"]) assert.match(loaded, new RegExp(`Loaded plugin "\\w+" from "[^"]*${file}"`));
	});
}
