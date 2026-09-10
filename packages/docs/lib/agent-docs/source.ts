import { source } from "@/lib/source";
import { createCatalog } from "./catalog";

export const docsOrigin = new URL(
	process.env.DOCS_SITE_URL ?? "https://lector-weld.vercel.app",
).origin;

export const catalog = createCatalog(
	source.getPages().map((page) => {
		const body: unknown = page.data._exports.agentMarkdown;
		if (typeof body !== "string" || !body.trim()) {
			throw new Error(`Missing agent Markdown export for ${page.url}`);
		}
		return {
			slug: page.slugs.join("/") || "index",
			title: page.data.title,
			description: page.data.description ?? "",
			body,
		};
	}),
	docsOrigin,
);
