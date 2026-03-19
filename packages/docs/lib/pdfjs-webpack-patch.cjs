// Workaround for webpack eval-source-map variable shadowing bug (webpack/webpack#20095).
// pdf.mjs declares 'var __webpack_exports__ = {}' which shadows webpack's own parameter
// inside eval(). Adding a reference expression makes webpack recognize and rename it.
// Safe to remove once Next.js bundles webpack >= 5.103.0.
module.exports = function (source) {
	return source.replace(
		"var __webpack_exports__ = {};",
		"var __webpack_exports__ = {};\n__webpack_exports__;",
	);
};
