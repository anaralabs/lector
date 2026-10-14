import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { normalizeSelectionText } from "../src/lib/text-normalization";

const sourceFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sourceFiles(join(dir, entry.name))
			: /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
				? [join(dir, entry.name)]
				: [],
	);

// Safari < 16.4 throws a SyntaxError on lookbehind when the module loads.
test("source uses no regex lookbehind", () => {
	const offenders = sourceFiles(join(__dirname, "../src")).filter((file) =>
		/\(\?<[=!]/.test(readFileSync(file, "utf8")),
	);
	expect(offenders).toEqual([]);
});

test.each([
	["a\nb\nc", "a b c"],
	["a\n\nb", "a\n\nb"],
	["\nstart", " start"],
	["中\n文\n字", "中文字"],
	["日本\nEnglish", "日本 English"],
])("joins single line breaks in %j", (text, expected) => {
	expect(normalizeSelectionText(text, { lineBreaks: "space" })).toBe(expected);
});

test.each([
	["inter-\nnational", "international"],
	["a-\nb-\nc", "abc"],
	["state-\nOf", "state-\nOf"],
	["inter-\n\nnational", "inter-\n\nnational"],
])("joins wrapped hyphens in %j", (text, expected) => {
	expect(normalizeSelectionText(text, { ignoreHyphenation: true })).toBe(
		expected,
	);
});
