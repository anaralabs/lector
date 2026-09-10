import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DocCatalog } from "../lib/agent-docs/catalog";

const origin = process.env.DOCS_URL ?? "http://localhost:3000";
async function get(path: string) {
	const response = await fetch(new URL(path, origin), {
		signal: AbortSignal.timeout(15000),
	});
	assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
	return response;
}
const fences = (markdown: string) =>
	[...markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```\s*$/gm)].map((match) => ({
		info: match[1],
		code: match[2],
	}));

test(
	"every published guide has a complete, discoverable Markdown export",
	{ timeout: 90000 },
	async (t) => {
		const manifest: DocCatalog["manifest"] = await (
			await get("/llms.json")
		).json();
		const llms = await (await get("/llms.txt")).text();
		const full = await (await get("/llms-full.txt")).text();
		const files = (await readdir("content/docs", { recursive: true })).filter(
			(path) => path.endsWith(".mdx"),
		);
		assert.deepEqual(
			manifest.pages.map((page) => page.slug).sort(),
			files
				.map((path) => path.replace(/\.mdx$/, "").replace(/\/index$/, ""))
				.sort(),
		);
		for (const page of manifest.pages) {
			await t.test(page.slug, async () => {
				const response = await get(new URL(page.markdownUrl).pathname);
				assert.match(
					response.headers.get("content-type") ?? "",
					/^text\/markdown/,
				);
				assert.match(
					response.headers.get("link") ?? "",
					/llms.txt.*describedby/,
				);
				const markdown = await response.text();
				assert.ok(markdown.startsWith(`# ${page.title}\n`));
				assert.ok(llms.includes(page.markdownUrl));
				assert.ok(full.includes(markdown));
				assert.equal(
					createHash("sha256").update(markdown).digest("hex"),
					page.sha256,
				);
				const source = await readFile(`content/docs/${page.slug}.mdx`, "utf8");
				assert.deepEqual(
					fences(markdown),
					fences(source),
					"every code fence and filename survives the export",
				);
				const outsideFences = markdown.replace(
					/^```[^\n]*\n[\s\S]*?^```\s*$/gm,
					"",
				);
				assert.doesNotMatch(outsideFences, /^import .*from /m);
				assert.doesNotMatch(
					outsideFences.replace(/`[^`]*`/g, ""),
					/<\/?[A-Z][A-Za-z]*(?:\s|\/?>)/,
				);
				const html = await (await get(new URL(page.url).pathname)).text();
				const alternate = html.match(
					/<link rel="alternate" type="text\/markdown" href="([^"]+)"/,
				);
				assert.ok(alternate, "HTML advertises Markdown alternate");
				assert.equal(
					new URL(alternate[1], origin).pathname,
					new URL(page.markdownUrl).pathname,
				);
			});
		}
		assert.equal(
			(await fetch(new URL("/docs/does-not-exist.md", origin))).status,
			404,
		);
	},
);

for (const mode of ["modern", "legacy"] as const) {
	test(
		`${mode} MCP client reads the production corpus over HTTP`,
		{ timeout: 60000 },
		async () => {
			const client =
				mode === "modern"
					? new Client(
							{ name: "integration-test", version: "1" },
							{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
						)
					: new LegacyClient({ name: "integration-test", version: "1" });
			const transport =
				mode === "modern"
					? new StreamableHTTPClientTransport(new URL("/mcp", origin))
					: new LegacyTransport(new URL("/mcp", origin));
			try {
				await client.connect(transport);
				if (client instanceof Client)
					await assert.rejects(client.listen({}), /Subscription limit reached/);
				assert.equal((await client.listTools()).tools.length, 3);
				const manifest: DocCatalog["manifest"] = await (
					await get("/llms.json")
				).json();
				const resources = await client.listResources();
				assert.equal(resources.resources.length, manifest.pages.length + 1);
				for (const page of manifest.pages) {
					const expected = await (
						await get(new URL(page.markdownUrl).pathname)
					).text();
					const result = await client.callTool({
						name: "get_doc",
						arguments: { slug: page.slug },
					});
					assert.equal(
						(result.structuredContent as Record<string, unknown>)?.markdown,
						expected,
					);
					const resource = await client.readResource({ uri: page.resourceUri });
					assert.ok("text" in resource.contents[0]);
					assert.equal(resource.contents[0].text, expected);
				}
				for (const [query, expected] of [
					["useSearch", "code/search"],
					["worker", "installation"],
					["colorScheme", "dark-mode"],
				]) {
					const result = await client.callTool({
						name: "search_docs",
						arguments: { query },
					});
					const data = result.structuredContent as {
						results: { slug: string }[];
					};
					assert.ok(
						data.results.some((page) => page.slug === expected),
						`${query} finds ${expected}`,
					);
				}
				const prompt = await client.getPrompt({
					name: "build_pdf_viewer",
					arguments: { framework: "nextjs" },
				});
				assert.ok(JSON.stringify(prompt).includes("ssr: false"));
			} finally {
				await client.close();
			}
		},
	);
}
