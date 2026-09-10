import { createHash } from "node:crypto";

export type DocInput = {
	slug: string;
	title: string;
	description: string;
	body: string;
};
export type AgentDoc = DocInput & {
	url: string;
	markdownUrl: string;
	resourceUri: string;
	markdown: string;
	sha256: string;
};

export const versionNotice =
	"These docs describe the source deployed with this site, tracking main rather than a versioned npm release. Check your installed @anaralabs/lector and pdfjs-dist versions before applying examples.";

export function markdownPath(slug: string) {
	return `/docs/${slug}.md`;
}

export function createCatalog(inputs: DocInput[], origin: string) {
	const docs: AgentDoc[] = inputs
		.map((doc) => {
			const url = new URL(
				doc.slug === "index" ? "/docs" : `/docs/${doc.slug}`,
				origin,
			).href;
			const markdownUrl = new URL(markdownPath(doc.slug), origin).href;
			const markdown = `# ${doc.title}\n\n${doc.description}\n\nSource: ${url}\n\n${versionNotice}\n\n${doc.body}`;
			return {
				...doc,
				url,
				markdownUrl,
				markdown,
				resourceUri: `lector://docs/${doc.slug}`,
				sha256: createHash("sha256").update(markdown).digest("hex"),
			};
		})
		.sort((a, b) =>
			a.slug === "index"
				? -1
				: b.slug === "index"
					? 1
					: a.slug.localeCompare(b.slug),
		);
	if (new Set(docs.map((doc) => doc.slug)).size !== docs.length)
		throw new Error("Duplicate agent documentation slug");
	const revision = createHash("sha256")
		.update(docs.map((doc) => `${doc.slug}:${doc.sha256}`).join("\n"))
		.digest("hex");
	const pages = docs.map(({ body, markdown, ...metadata }) => metadata);
	const manifest = {
		name: "Lector",
		schemaVersion: 1,
		revision,
		versionNotice,
		mcpUrl: new URL("/mcp", origin).href,
		pages,
	};
	const llms = `# Lector\n\n> A headless PDF viewer for React, built on PDF.js.\n\n${versionNotice}\n\nStart with installation, then your first viewer. Read the relevant recipe and API reference before writing an integration. All guides below are complete Markdown exports; live demos run on the linked HTML page.\n\n## Guides and reference\n\n${docs.map((doc) => `- [${doc.title}](${doc.markdownUrl}): ${doc.description}`).join("\n")}\n\n## Optional\n\n- [Complete documentation](${new URL("/llms-full.txt", origin)}): All guides in one response; prefer individual pages for focused tasks.\n- [Machine-readable catalog](${new URL("/llms.json", origin)}): Page URLs, resource URIs, and content hashes.\n`;
	return {
		docs,
		manifest,
		llms,
		full: `# Lector: complete documentation\n\n${versionNotice}\n\n${docs.map((doc) => doc.markdown).join("\n\n---\n\n")}`,
		get: (slug: string) => docs.find((doc) => doc.slug === slug),
		search: (query: string, limit = 5) => searchDocs(docs, query, limit),
	};
}

export type DocCatalog = ReturnType<typeof createCatalog>;

function tokens(value: string): string[] {
	return (
		value
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.match(/[a-z0-9]+/g) ?? []
	);
}

function searchDocs(docs: AgentDoc[], query: string, limit: number) {
	const terms = [...new Set(tokens(query))];
	if (!terms.length) return [];
	return docs
		.map((doc) => {
			const title = new Set(tokens(`${doc.title} ${doc.slug}`));
			const description = new Set(tokens(doc.description));
			const body = new Set(tokens(doc.body));
			const matches = terms.filter(
				(term) => title.has(term) || description.has(term) || body.has(term),
			);
			const score =
				matches.reduce(
					(sum, term) =>
						sum +
						(title.has(term) ? 12 : 0) +
						(description.has(term) ? 6 : 0) +
						(body.has(term) ? 1 : 0),
					0,
				) *
				(matches.length / terms.length);
			const lines = doc.body.split(/\n\s*\n/);
			const excerpt =
				lines
					.map((text) => ({
						text,
						hits: terms.filter((term) => tokens(text).includes(term)).length,
					}))
					.sort((a, b) => b.hits - a.hits)[0]
					?.text.slice(0, 600) ?? doc.description;
			return {
				slug: doc.slug,
				title: doc.title,
				description: doc.description,
				url: doc.url,
				markdownUrl: doc.markdownUrl,
				resourceUri: doc.resourceUri,
				score,
				excerpt,
			};
		})
		.filter((doc) => doc.score > 0)
		.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
		.slice(0, Math.max(1, Math.min(10, limit)));
}
