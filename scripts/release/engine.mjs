// semantic-release config for @anaralabs/lector-engine (CI: semantic-release --extends).
const here = (file) => new URL(file, import.meta.url).pathname;
const paths = { package: "packages/engine/" };

export default {
	tagFormat: "lector-engine-v${version}",
	plugins: [[here("./commits.mjs"), paths], "@semantic-release/npm", [here("./github.mjs"), paths]],
};
