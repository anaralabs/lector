// semantic-release plugin: @semantic-release/commit-analyzer and
// release-notes-generator over the package's own commits (see paths.mjs).
// Options: the paths.mjs options, plus `analyzer` / `notes` for the wrapped plugins.
import { onlyPackageCommits, plugin } from "./paths.mjs";

export async function analyzeCommits(options, context) {
	const { analyzeCommits } = await plugin("@semantic-release/commit-analyzer");
	return analyzeCommits(options.analyzer ?? {}, onlyPackageCommits(options, context));
}

export async function generateNotes(options, context) {
	const { generateNotes } = await plugin("@semantic-release/release-notes-generator");
	return generateNotes(options.notes ?? {}, onlyPackageCommits(options, context));
}
