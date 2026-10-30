// node --test scripts/release/paths.test.mjs  (builds throwaway git repos; nothing is pushed)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import engine from "./engine.mjs";
import lector from "./lector.mjs";
import { onlyPackageCommits } from "./paths.mjs";

const lectorPaths = lector.plugins[0][1];
const enginePaths = engine.plugins[0][1];
const dirs = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const lock = ({ root = "1.0.0", lectorDep = "1.0.0", engineDep = "", overrides = "" } = {}) => `lockfileVersion: '9.0'
${overrides ? `\noverrides:\n  handlebars: ${overrides}\n` : ""}
importers:

  .:
    devDependencies:
      turbo:
        specifier: ^2
        version: ${root}

  packages/engine:
    devDependencies:
      pdf-lib:
        specifier: 1.17.1
        version: 1.17.1${engineDep ? `\n      mupdf:\n        specifier: ${engineDep}\n        version: ${engineDep}` : ""}

  packages/lector:
    dependencies:
      pdfjs-dist:
        specifier: ^5
        version: ${lectorDep}

packages:

  pdf-lib@1.17.1:
    resolution: {integrity: sha512-a}
${engineDep ? `\n  mupdf@${engineDep}:\n    resolution: {integrity: sha512-b}\n` : ""}`;

function repo() {
	const dir = mkdtempSync(join(tmpdir(), "release-paths-"));
	dirs.push(dir);
	const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	const write = (files) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), text);
		}
	};
	const commit = (message, files) => {
		write(files);
		git("add", "-A");
		git("commit", "-q", "--allow-empty", "-m", message);
		return { hash: git("rev-parse", "HEAD"), message, subject: message.split("\n")[0] };
	};
	commit("chore: init", { "package.json": "{}\n", "pnpm-lock.yaml": lock(), "packages/lector/a.ts": "1", "packages/engine/a.ts": "1", "README.md": "x" });
	return { dir, git, write, commit };
}

const logger = { log() {}, error() {} };
const pick = (paths, dir, commits) => onlyPackageCommits(paths, { cwd: dir, commits, logger }).commits.map((c) => c.subject);

test("lector: its folder, root inputs and lockfile changes beyond the engine; engine: its folder", () => {
	const { dir, commit } = repo();
	const commits = [
		commit("fix(deps): pin handlebars", { "package.json": '{"pnpm":{"overrides":{"handlebars":"4.7.10"}}}\n', "pnpm-lock.yaml": lock({ overrides: "4.7.10" }) }),
		commit("fix(engine): add mupdf", { "packages/engine/package.json": "{}", "pnpm-lock.yaml": lock({ overrides: "4.7.10", engineDep: "1.27.0" }) }),
		commit("fix(deps): bump pdfjs-dist in the lockfile", { "pnpm-lock.yaml": lock({ overrides: "4.7.10", engineDep: "1.27.0", lectorDep: "1.1.0" }) }),
		// A squash with a lector-affecting root change plus an unrelated engine edit.
		commit("fix: patch an advisory everywhere", { "patches/x.patch": "p", "packages/engine/README.md": "y" }),
		commit("chore(deps): re-resolve root tooling", { "pnpm-lock.yaml": lock({ overrides: "4.7.10", engineDep: "1.27.0", lectorDep: "1.1.0", root: "2.0.0" }) }),
		commit("fix(lector): a bug", { "packages/lector/a.ts": "2" }),
		commit("docs: readme", { "README.md": "z" }),
	];
	assert.deepEqual(pick(lectorPaths, dir, commits), ["fix(deps): pin handlebars", "fix(deps): bump pdfjs-dist in the lockfile", "fix: patch an advisory everywhere", "fix(lector): a bug"]);
	assert.deepEqual(pick(enginePaths, dir, commits), ["fix(engine): add mupdf", "fix: patch an advisory everywhere"]);
});

test("merge commits are compared with their first parent", () => {
	const { dir, git, commit } = repo();
	git("checkout", "-q", "-b", "topic");
	commit("feat(lector): on a branch", { "packages/lector/b.ts": "1" });
	git("checkout", "-q", "main");
	commit("fix(engine): meanwhile", { "packages/engine/b.ts": "1" });
	git("merge", "-q", "--no-ff", "topic", "-m", "feat(lector)!: merge topic\n\nBREAKING CHANGE: new API");
	const merge = { hash: git("rev-parse", "HEAD"), message: git("log", "-1", "--format=%B"), subject: "feat(lector)!: merge topic" };
	assert.deepEqual(pick(lectorPaths, dir, [merge]), ["feat(lector)!: merge topic"]);
	assert.deepEqual(pick(enginePaths, dir, [merge]), []);
});

test("a merge's breaking change makes a major lector release", async (t) => {
	let analyzeCommits;
	try {
		({ analyzeCommits } = await import("./commits.mjs"));
		await (await import("./paths.mjs")).plugin("@semantic-release/commit-analyzer");
	} catch {
		t.skip("semantic-release is not installed");
		return;
	}
	const { dir, git, commit } = repo();
	git("checkout", "-q", "-b", "topic");
	commit("chore: work", { "packages/lector/b.ts": "1" });
	git("checkout", "-q", "main");
	git("merge", "-q", "--no-ff", "topic", "-m", "feat(lector): merge topic\n\nBREAKING CHANGE: new API");
	const merge = { hash: git("rev-parse", "HEAD"), message: git("log", "-1", "--format=%B"), subject: "feat(lector): merge topic" };
	assert.equal(await analyzeCommits(lectorPaths, { cwd: dir, commits: [merge], logger }), "major");
	assert.equal(await analyzeCommits(enginePaths, { cwd: dir, commits: [merge], logger }), null);
});
