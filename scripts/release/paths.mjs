// Which commits belong to a package. Shared by the release plugins in this folder.
//
// Plugin options:
//   package:  "packages/lector/"   files under it always count
//   shared:   ["package.json", "patches/", ...]   these count too (root inputs of every package)
//   lockfile: { path: "pnpm-lock.yaml", ignore: ["packages/engine", "."] }
//             a lockfile change counts unless it only changes ignored importers and
//             packages no other importer reaches (before or after the commit): an
//             engine-only dependency change does not release lector; an override, a
//             lector dependency or anything shared with lector does
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

const unquote = (k) => k.trim().replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
/** "name@1.0.0(peer@2)" -> "name@1.0.0"; v6 keys also drop their leading "/" */
const base = (key) => key.split("(")[0];

/**
 * A pnpm lockfile (v6 or v9), read just far enough for release filtering:
 * the text of each top-level section, importer and package/snapshot entry, the
 * importers' resolved dependencies and each entry's dependencies.
 */
function parseLock(text) {
	const sections = new Map(); // "top:x" / "importer:path" -> text
	const entries = new Map(); // package/snapshot key (peers included) -> text
	const importers = new Map(); // path -> ["name@version", ...]
	const deps = new Map(); // full entry key -> ["name@version", ...]
	let top = "";
	let key = "";
	let entry = "";
	let importer = "";
	let depName = "";
	let inDeps = false;
	for (const line of text.split("\n")) {
		const t = /^([^\s#][^:]*):/.exec(line);
		if (t) {
			top = t[1];
			key = `top:${top}`;
			entry = importer = "";
		} else if (top === "importers" && /^ {2}\S/.test(line)) {
			importer = unquote(line.slice(2, line.lastIndexOf(":")));
			key = `importer:${importer}`;
			importers.set(importer, []);
		} else if ((top === "packages" || top === "snapshots") && /^ {2}\S/.test(line)) {
			const k = line.trimEnd().endsWith("{}") ? line.trim().slice(0, -4) : line.slice(2, line.lastIndexOf(":"));
			entry = unquote(k).replace(/^\//, "");
			deps.set(entry, deps.get(entry) ?? []);
			inDeps = false;
		} else if (importer && /^ {4}\S/.test(line)) {
			inDeps = /^ {4}(dependencies|devDependencies|optionalDependencies):/.test(line);
		} else if (importer && inDeps && /^ {6}\S/.test(line)) {
			depName = unquote(line.trim().slice(0, -1));
		} else if (importer && inDeps && /^ {8}version:/.test(line)) {
			const version = line.trim().slice("version:".length).trim();
			if (!version.startsWith("link:")) importers.get(importer).push(depKey(depName, unquote(version)));
		} else if (entry && /^ {4}\S/.test(line)) {
			inDeps = /^ {4}(dependencies|optionalDependencies):/.test(line);
		} else if (entry && inDeps && /^ {6}\S/.test(line)) {
			const m = /^\s+('[^']+'|"[^"]+"|[^:\s]+):\s*(.+)$/.exec(line);
			if (m && !m[2].startsWith("link:")) deps.get(entry).push(depKey(unquote(m[1]), unquote(m[2]).replace(/^\//, "")));
		}
		if (entry) entries.set(`${top}:${entry}`, `${entries.get(`${top}:${entry}`) ?? ""}${line}\n`);
		else sections.set(key, `${sections.get(key) ?? ""}${line}\n`);
	}
	return { sections, entries, importers, deps };
}

/** "name@version", or the target itself for an alias ("alias: real@1.0.0"). */
const depKey = (name, version) => (/^(@[^@/]+\/)?[^@(/]+@/.test(version) ? version : `${name}@${version}`);

/** Every entry key reachable from the given importers, with and without peers. */
function reachable(lock, from) {
	const byBase = new Map();
	for (const k of lock.deps.keys()) {
		const b = base(k);
		byBase.set(b, [...(byBase.get(b) ?? []), k]);
	}
	const seen = new Set();
	const queue = from.flatMap((i) => lock.importers.get(i) ?? []);
	while (queue.length) {
		const k = queue.pop();
		if (seen.has(k)) continue;
		seen.add(k);
		seen.add(base(k));
		// The exact snapshot, else every snapshot of that version.
		for (const full of lock.deps.has(k) ? [k] : (byBase.get(base(k)) ?? [])) {
			seen.add(full);
			queue.push(...(lock.deps.get(full) ?? []));
		}
	}
	return seen;
}

const show = (cwd, rev, path) => {
	try {
		return git(cwd, "show", `${rev}:${path}`);
	} catch {
		return "";
	}
};

/**
 * Does this commit's lockfile change reach the package? Conservative: it does
 * unless the only changes are ignored importers (root tooling, the engine) and
 * packages that no other importer reaches, before or after the commit.
 */
export function lockfileMatters(cwd, hash, lockfile) {
	const before = parseLock(show(cwd, `${hash}^1`, lockfile.path));
	const after = parseLock(show(cwd, hash, lockfile.path));
	const ignored = new Set(lockfile.ignore ?? []);
	const differs = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
	for (const k of differs(before.sections, after.sections)) {
		if (k === "top:packages" || k === "top:snapshots" || k === "top:importers") continue;
		if (!k.startsWith("importer:") || !ignored.has(k.slice("importer:".length))) return true;
	}
	const changed = differs(before.entries, after.entries);
	if (!changed.length) return false;
	const others = [...new Set([...before.importers.keys(), ...after.importers.keys()])].filter((i) => !ignored.has(i));
	const reach = new Set([...reachable(before, others), ...reachable(after, others)]);
	// "packages:" entries are per version (any peer variant), "snapshots:" per variant.
	return changed.some((k) => reach.has(k.slice(k.indexOf(":") + 1)));
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
