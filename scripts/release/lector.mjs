// semantic-release config for @anaralabs/lector (CI: semantic-release --extends).
// Kept out of packages/lector so release-config changes are not lector commits.
const here = (file) => new URL(file, import.meta.url).pathname;
const paths = {
	package: "packages/lector/",
	shared: ["package.json", "pnpm-workspace.yaml", "patches/"],
	lockfile: { path: "pnpm-lock.yaml", ignore: [".", "packages/engine"] },
};

export default {
	tagFormat: "v${version}",
	plugins: [[here("./commits.mjs"), paths], here("./npm.mjs"), [here("./github.mjs"), paths]],
};
