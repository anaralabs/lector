import { getHighlighter, type Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter>;

export async function highlight(code: string, lang = "tsx") {
	if (!highlighterPromise) {
		highlighterPromise = getHighlighter({
			themes: ["github-dark"],
			langs: ["typescript", "tsx", "javascript", "jsx"],
		});
	}

	const highlighter = await highlighterPromise;
	return highlighter.codeToHtml(code, { lang, theme: "github-dark" });
}
