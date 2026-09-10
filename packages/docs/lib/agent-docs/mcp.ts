import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { DocCatalog } from "./catalog";

const annotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
const result = (data: Record<string, unknown>) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data) }],
	structuredContent: data,
});

export function createDocsServer(catalog: DocCatalog) {
	const server = new McpServer(
		{ name: "lector-docs", version: "1.0.0" },
		{
			capabilities: {
				tools: { listChanged: false },
				resources: { listChanged: false },
				prompts: { listChanged: false },
			},
			instructions:
				"Search Lector documentation, then read the complete relevant pages before writing code. These docs track the deployed source, not a versioned npm release. Check the consumer's installed versions. Tools only read public Lector documentation; they cannot inspect PDFs or modify applications.",
		},
	);
	server.registerTool(
		"list_docs",
		{
			description:
				"List all Lector guides, canonical slugs, Markdown URLs, resource URIs, and the documentation revision. Start here to discover available topics.",
			inputSchema: z.object({}),
			annotations,
		},
		async () => result(catalog.manifest),
	);
	server.registerTool(
		"search_docs",
		{
			description:
				"Search Lector guide titles, descriptions, and code/prose by keywords (for example: worker, Next.js, useSearch, dark mode). Returns ranked excerpts, not complete guides. Read relevant results with get_doc. No matches returns an empty results array.",
			inputSchema: z.object({
				query: z.string().trim().min(1).max(200),
				limit: z.number().int().min(1).max(10).default(5),
			}),
			annotations,
		},
		async ({ query, limit }) =>
			result({
				revision: catalog.manifest.revision,
				results: catalog.search(query, limit),
			}),
	);
	server.registerTool(
		"get_doc",
		{
			description:
				"Read one complete Lector guide, including code examples. Use a slug returned by list_docs or search_docs, such as installation, api, code/search, or index for the overview. Only catalog slugs are accepted; this does not fetch arbitrary URLs or files.",
			inputSchema: z.object({ slug: z.string().min(1).max(100) }),
			annotations,
		},
		async ({ slug }) => {
			const doc = catalog.get(slug);
			if (!doc)
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Unknown documentation slug: ${slug}. Use list_docs to find available pages.`,
						},
					],
				};
			return result({
				slug: doc.slug,
				url: doc.url,
				markdownUrl: doc.markdownUrl,
				sha256: doc.sha256,
				markdown: doc.markdown,
			});
		},
	);
	server.registerResource(
		"documentation-index",
		"lector://docs",
		{
			title: "Lector documentation catalog",
			description: "All documentation pages, URLs, and content hashes.",
			mimeType: "application/json",
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "application/json",
					text: JSON.stringify(catalog.manifest),
				},
			],
		}),
	);
	for (const doc of catalog.docs) {
		server.registerResource(
			doc.slug,
			doc.resourceUri,
			{
				title: doc.title,
				description: doc.description,
				mimeType: "text/markdown",
			},
			async (uri) => ({
				contents: [
					{ uri: uri.href, mimeType: "text/markdown", text: doc.markdown },
				],
			}),
		);
	}
	server.registerPrompt(
		"build_pdf_viewer",
		{
			title: "Build a Lector PDF viewer",
			description:
				"Start a React or Next.js integration with the current installation and first-viewer guides.",
			argsSchema: z.object({
				framework: z
					.enum(["react", "nextjs"])
					.describe("Application framework: react or nextjs"),
			}),
		},
		({ framework }) => ({
			messages: [
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text: `Help me build a Lector PDF viewer in ${framework === "nextjs" ? "Next.js" : "React"}. First inspect the app's installed dependencies and layout. Follow the setup below, adapt the asset paths to the app, and verify rendering and text selection. Read additional feature guides with get_doc as needed.\n\n${["installation", "basic-usage"].map((slug) => catalog.get(slug)?.markdown ?? "").join("\n\n")}`,
					},
				},
			],
		}),
	);
	return server;
}

// A fresh server per request works across serverless instances and keeps clients
// isolated. The SDK also supports clients using the 2025 initialize handshake.
export function createDocsHandler(
	catalog: DocCatalog,
	allowedOrigins: string[],
) {
	const handler = createMcpHandler(() => createDocsServer(catalog), {
		legacy: "stateless",
		// The corpus is immutable for this deployment; there are no live events.
		maxSubscriptions: 0,
	});
	const origins = new Set(allowedOrigins);
	return async (request: Request) => {
		const origin = request.headers.get("origin");
		if (origin && !origins.has(origin))
			return new Response("Origin not allowed", {
				status: 403,
				headers: { "Cache-Control": "no-store", Vary: "Origin" },
			});
		const headers = new Headers({
			"Cache-Control": "no-store",
			Vary: "Origin",
		});
		if (origin) {
			headers.set("Access-Control-Allow-Origin", origin);
			headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
			headers.set(
				"Access-Control-Allow-Headers",
				"Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, MCP-Method, MCP-Name, Last-Event-ID",
			);
			headers.set(
				"Access-Control-Expose-Headers",
				"MCP-Protocol-Version, MCP-Session-Id",
			);
		}
		const respond = (body: string | null, status: number) =>
			new Response(body, { status, headers });
		if (request.method === "OPTIONS") return respond(null, 204);
		if (request.method !== "POST") {
			headers.set("Allow", "POST, OPTIONS");
			return respond(
				"Use an MCP Streamable HTTP client to POST to this endpoint. See /docs/agents.",
				405,
			);
		}
		// Bound both declared and chunked bodies before the SDK parses JSON.
		const maxBytes = 64 * 1024;
		if (Number(request.headers.get("content-length")) > maxBytes)
			return respond("Request too large", 413);
		const reader = request.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > maxBytes) {
						await reader.cancel();
						return respond("Request too large", 413);
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
		}
		const body = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.length;
		}
		const response = await handler.fetch(
			new Request(request.url, {
				method: "POST",
				headers: request.headers,
				body,
				signal: request.signal,
			}),
		);
		for (const [key, value] of headers) response.headers.set(key, value);
		return response;
	};
}
