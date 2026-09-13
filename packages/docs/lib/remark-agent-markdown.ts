import type { Root } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import type { Plugin } from "unified";

const interactiveExamples = new Set([
	"Basic",
	"WithThumbnails",
	"PdfFormLayer",
	"LinkDemo",
	"HighlightDemo",
	"PdfHighlightSelect",
	"SearchDemo",
	"PageNavigation",
	"ViewerZoomControl",
]);

export const remarkAgentMarkdown: Plugin<[], Root> = () => (tree, file) => {
	const clean = (node: Record<string, unknown>): Record<string, unknown>[] => {
		if (node.type === "mdxjsEsm") return [];
		if (
			node.type === "mdxFlowExpression" ||
			node.type === "mdxTextExpression"
		) {
			throw new Error(
				"Agent Markdown requires prose instead of MDX expressions.",
			);
		}
		const children = Array.isArray(node.children)
			? node.children.flatMap((child) => clean(child))
			: undefined;
		if (
			node.type === "mdxJsxFlowElement" ||
			node.type === "mdxJsxTextElement"
		) {
			if (children?.length) return children;
			if (
				node.type === "mdxJsxTextElement" ||
				!interactiveExamples.has(String(node.name))
			) {
				throw new Error(
					"Agent Markdown requires prose or an explicit export mapping for this MDX component.",
				);
			}
			return [
				{
					type: "paragraph",
					children: [
						{
							type: "text",
							value:
								"Open the documentation page linked above to use this interactive example.",
						},
					],
				},
			];
		}
		const url =
			typeof node.url === "string" && node.url.startsWith("/")
				? new URL(
						node.url.replace(/^\//, ""),
						`${(process.env.DOCS_SITE_URL ?? "https://anara.com/lector").replace(/\/$/, "")}/`,
					).href
				: undefined;
		return [
			{ ...node, ...(url ? { url } : {}), ...(children ? { children } : {}) },
		];
	};
	const [markdownTree] = clean(tree as unknown as Record<string, unknown>);
	file.data.agentMarkdown = toMarkdown(markdownTree as unknown as Root, {
		extensions: [gfmToMarkdown()],
	});
};
