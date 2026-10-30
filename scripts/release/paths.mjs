// Which commits belong to a package. Shared by the release plugins in this folder.
//
// Plugin options:
//   package: "packages/lector/"   files under it always count
//   shared:  ["package.json", "pnpm-lock.yaml", "patches/", ...]
//            count when the commit touches no `others` path (root dependency fixes
//            release the package; an engine-only dependency change does not)
//   others:  ["packages/engine/"]
// Entries ending in "/" are folders; the rest are exact paths from the repo root.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const files = new Map();
function commitFiles(cwd, hash) {
	let list = files.get(hash);
	if (!list) {
		const out = execFileSync("git", ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", hash], { cwd, encoding: "utf8" });
		list = out.split("\n").filter(Boolean);
		files.set(hash, list);
	}
	return list;
}

const matches = (file, entries = []) => entries.some((e) => (e.endsWith("/") ? file.startsWith(e) : file === e));

export function belongs(paths, changed) {
	if (changed.some((f) => matches(f, [paths.package]))) return true;
	return changed.some((f) => matches(f, paths.shared)) && !changed.some((f) => matches(f, paths.others));
}

/** The context with only this package's commits. */
export function onlyPackageCommits(paths, context) {
	const commits = context.commits.filter((c) => belongs(paths, commitFiles(context.cwd, c.hash)));
	context.logger.log("Found %s of %s commits for %s since the last release", commits.length, context.commits.length, paths.package);
	return { ...context, commits };
}

/** Imports one of semantic-release's own plugin packages (pnpm keeps them next to it). */
export async function plugin(name) {
	const require = createRequire(createRequire(import.meta.url).resolve("semantic-release"));
	return import(pathToFileURL(require.resolve(name)).href);
}
