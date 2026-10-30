// Which commits belong to a package. Shared by the release plugins in this folder.
//
// Plugin options:
//   package:  "packages/lector/"   files under it always count
//   shared:   ["package.json", "patches/", ...]   these count too (root inputs of every package)
//   lockfile: { path: "pnpm-lock.yaml", ignore: ["packages/engine", "."] }
//             a lockfile change counts unless it only changes ignored importers (and
//             the packages they pulled in): an engine-only dependency change does not
//             release lector, an override or a lector dependency change does
// Entries ending in "/" are folders; the rest are exact paths from the repo root.
// Merge commits are compared with their first parent, so their message (and any
// BREAKING CHANGE in it) counts like a squash's.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const files = new Map();
export function commitFiles(cwd, hash) {
	let list = files.get(hash);
	if (!list) {
		list = git(cwd, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "--diff-merges=first-parent", hash).split("\n").filter(Boolean);
		files.set(hash, list);
	}
	return list;
}

/** Top-level sections and importers of a pnpm lockfile, as text keyed "top:name" / "importer:path". */
function lockSections(text) {
	const out = new Map();
	let top = "";
	let key = "";
	for (const line of text.split("\n")) {
		const t = /^([^\s#][^:]*):/.exec(line);
		if (t) {
			top = t[1];
			key = `top:${top}`;
		} else if (top === "importers") {
			const imp = /^ {2}([^\s][^:]*):\s*$/.exec(line);
			if (imp) key = `importer:${imp[1].replace(/^'|'$/g, "")}`;
		}
		out.set(key, `${out.get(key) ?? ""}${line}\n`);
	}
	return out;
}

const show = (cwd, rev, path) => {
	try {
		return git(cwd, "show", `${rev}:${path}`);
	} catch {
		return "";
	}
};

/** Does this commit's lockfile change reach anything but the ignored importers? */
export function lockfileMatters(cwd, hash, lockfile) {
	const before = lockSections(show(cwd, `${hash}^1`, lockfile.path));
	const after = lockSections(show(cwd, hash, lockfile.path));
	const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
	const ignored = new Set((lockfile.ignore ?? []).map((i) => `importer:${i}`));
	const importers = changed.filter((k) => k.startsWith("importer:"));
	if (importers.some((k) => !ignored.has(k))) return true;
	// Resolved packages follow the importers that changed; with no importer change
	// (an override, a re-resolution) they may affect anyone.
	const other = changed.filter((k) => !k.startsWith("importer:") && k !== "top:importers");
	return other.some((k) => (k !== "top:packages" && k !== "top:snapshots") || importers.length === 0);
}

const matches = (file, entries = []) => entries.some((e) => (e.endsWith("/") ? file.startsWith(e) : file === e));

export function belongs(paths, changed, lockfileChange = () => true) {
	if (changed.some((f) => matches(f, [paths.package]) || matches(f, paths.shared))) return true;
	return !!paths.lockfile && changed.includes(paths.lockfile.path) && lockfileChange();
}

/** The context with only this package's commits. */
export function onlyPackageCommits(paths, context) {
	const commits = context.commits.filter((c) => belongs(paths, commitFiles(context.cwd, c.hash), () => lockfileMatters(context.cwd, c.hash, paths.lockfile)));
	context.logger.log("Found %s of %s commits for %s since the last release", commits.length, context.commits.length, paths.package);
	return { ...context, commits };
}

/** Imports one of semantic-release's own plugin packages (pnpm keeps them next to it). */
export async function plugin(name) {
	const require = createRequire(createRequire(import.meta.url).resolve("semantic-release"));
	return import(pathToFileURL(require.resolve(name)).href);
}
