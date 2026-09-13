import assert from "node:assert/strict";
import { test } from "node:test";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Root } from "mdast";
import { unified } from "unified";
import { createCatalog } from "../lib/agent-docs/catalog";
import { createDocsHandler } from "../lib/agent-docs/mcp";
import { remarkAgentMarkdown } from "../lib/remark-agent-markdown";

const inputs = [
	{
		slug: "index",
		title: "Overview",
		description: "Headless PDF viewer",
		body: "Compose a viewer.",
	},
	{
		slug: "installation",
		title: "Installation",
		description: "Configure the PDF.js worker",
		body: '## Worker setup\n\nUse a matching PDF.js worker.\n\n```tsx\n<Root source="/sample.pdf" />\n```\n',
	},
	{
		slug: "basic-usage",
		title: "Your first viewer",
		description: "Add a toolbar",
		body: "Start with installation. Configure the worker first.",
	},
	{
		slug: "code/search",
		title: "Search",
		description: "Find text with useSearch",
		body: "Use `useSearch` to search embedded text. No OCR.",
	},
];
const catalog = createCatalog(inputs, "https://docs.example");
const handle = createDocsHandler(catalog, ["https://docs.example"]);
// Emulate browser preflight for the actual headers emitted by both SDKs.
const localFetch: typeof fetch = async (input, init) => {
	const request = new Request(input, init);
	const names = [...request.headers.keys()];
	const preflight = await handle(
		new Request(request.url, {
			method: "OPTIONS",
			headers: {
				origin: "https://docs.example",
				"access-control-request-method": request.method,
				"access-control-request-headers": names.join(", "),
			},
		}),
	);
	const allowed = (preflight.headers.get("access-control-allow-headers") ?? "")
		.toLowerCase()
		.split(/,\s*/);
	for (const name of names)
		assert.ok(allowed.includes(name), `CORS permits SDK header ${name}`);
	assert.ok(
		preflight.headers
			.get("access-control-allow-methods")
			?.includes(request.method),
	);
	request.headers.set("origin", "https://docs.example");
	const response = await handle(request);
	assert.equal(
		response.headers.get("access-control-allow-origin"),
		"https://docs.example",
	);
	return response;
};

test("catalog revisions track content, independent of source enumeration order", () => {
	assert.equal(
		catalog.manifest.revision,
		createCatalog([...inputs].reverse(), "https://docs.example").manifest
			.revision,
	);
	assert.notEqual(
		catalog.manifest.revision,
		createCatalog(
			inputs.map((doc) => ({ ...doc, body: `${doc.body}\nEdited` })),
			"https://docs.example",
		).manifest.revision,
	);
	assert.equal(catalog.get("../../etc/passwd"), undefined);
	assert.match(catalog.llms, /https:\/\/docs.example\/docs\/code\/search.md/);
	assert.ok(
		catalog.full.includes(catalog.get("installation")?.markdown ?? "missing"),
	);
	assert.equal(catalog.search("worker")[0].slug, "installation");
	assert.equal(catalog.search("useSearch")[0].slug, "code/search");
	assert.deepEqual(catalog.search("unfindableterm"), []);
	assert.deepEqual(catalog.search(".*[]"), []);
	assert.equal(catalog.search("worker", 1).length, 1);
});

test("Markdown export retains JSX inside fences and prose inside wrappers without mutating MDX", async () => {
	const tree = {
		type: "root",
		children: [
			{ type: "mdxjsEsm", value: 'import Demo from "./demo"' },
			{
				type: "code",
				lang: "tsx",
				meta: 'title="viewer.tsx"',
				value: "<Root source={file}>\n  <CanvasLayer />\n</Root>",
			},
			{
				type: "mdxJsxFlowElement",
				name: "Callout",
				children: [
					{
						type: "paragraph",
						children: [
							{ type: "text", value: "Keep this important prerequisite." },
						],
					},
				],
			},
			{ type: "mdxJsxFlowElement", name: "Basic", children: [] },
		],
	} as unknown as Root;
	const original = structuredClone(tree);
	const file = { data: {} as Record<string, unknown> };
	await unified().use(remarkAgentMarkdown).run(tree, file);
	const markdown = String(file.data.agentMarkdown);
	assert.match(markdown, /```tsx title="viewer.tsx"/);
	assert.ok(
		markdown.includes("<Root source={file}>\n  <CanvasLayer />\n</Root>"),
	);
	assert.match(markdown, /Keep this important prerequisite/);
	assert.match(markdown, /interactive example/);
	assert.ok(!markdown.includes("import Demo"));
	assert.deepEqual(tree, original);
	await assert.rejects(
		unified()
			.use(remarkAgentMarkdown)
			.run({
				type: "root",
				children: [{ type: "mdxFlowExpression", value: "secret" }],
			} as unknown as Root),
		/requires prose/,
	);
});

for (const mode of ["modern", "legacy"] as const) {
	test(
		`${mode} SDK client discovers and reads tools, resources, and prompts`,
		{ timeout: 15000 },
		async () => {
			const client =
				mode === "modern"
					? new Client(
							{ name: "test", version: "1" },
							{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
						)
					: new LegacyClient({ name: "test", version: "1" });
			const transport =
				mode === "modern"
					? new StreamableHTTPClientTransport(
							new URL("https://docs.example/mcp"),
							{ fetch: localFetch },
						)
					: new LegacyTransport(new URL("https://docs.example/mcp"), {
							fetch: localFetch,
						});
			try {
				await client.connect(transport);
				if (client instanceof Client)
					await assert.rejects(client.listen({}), /Subscription limit reached/);
				const tools = await client.listTools();
				assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
					"get_doc",
					"list_docs",
					"search_docs",
				]);
				assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint));
				const read = await client.callTool({
					name: "get_doc",
					arguments: { slug: "installation" },
				});
				assert.equal(
					(read.structuredContent as Record<string, unknown>)?.markdown,
					catalog.get("installation")?.markdown,
				);
				const missing = await client.callTool({
					name: "get_doc",
					arguments: { slug: "https://elsewhere.example" },
				});
				assert.equal(missing.isError, true);
				const invalid = await client.callTool({
					name: "search_docs",
					arguments: { query: "worker", limit: 100 },
				});
				assert.equal(invalid.isError, true);
				const [search, list] = await Promise.all([
					client.callTool({
						name: "search_docs",
						arguments: { query: "worker" },
					}),
					client.callTool({ name: "list_docs", arguments: {} }),
				]);
				assert.ok(JSON.stringify(search).includes("installation"));
				assert.equal(
					(list.structuredContent as Record<string, unknown>)?.revision,
					catalog.manifest.revision,
				);
				const resources = await client.listResources();
				assert.equal(resources.resources.length, inputs.length + 1);
				const resource = await client.readResource({
					uri: "lector://docs/installation",
				});
				assert.ok("text" in resource.contents[0]);
				assert.equal(
					resource.contents[0].text,
					catalog.get("installation")?.markdown,
				);
				await assert.rejects(
					client.readResource({ uri: "file:///etc/passwd" }),
				);
				assert.equal(
					(await client.listPrompts()).prompts[0].name,
					"build_pdf_viewer",
				);
				const prompt = await client.getPrompt({
					name: "build_pdf_viewer",
					arguments: { framework: "nextjs" },
				});
				assert.ok(JSON.stringify(prompt).includes("Next.js"));
				assert.ok(JSON.stringify(prompt).includes("Worker setup"));
			} finally {
				await client.close();
			}
		},
	);
}

test("HTTP rejects hostile origins, oversized chunked bodies, and unsupported methods", async () => {
	assert.equal(
		(
			await handle(
				new Request("https://docs.example/mcp", {
					method: "POST",
					headers: { origin: "https://evil.example" },
				}),
			)
		).status,
		403,
	);
	const allowed = await handle(
		new Request("https://docs.example/mcp", {
			method: "OPTIONS",
			headers: { origin: "https://docs.example" },
		}),
	);
	assert.equal(allowed.status, 204);
	assert.equal(
		allowed.headers.get("access-control-allow-origin"),
		"https://docs.example",
	);
	assert.equal(
		(await handle(new Request("https://docs.example/mcp"))).status,
		405,
	);
	const big = new Request("https://docs.example/mcp", {
		method: "POST",
		body: "x".repeat(65537),
	});
	assert.equal(big.headers.get("content-length"), null);
	assert.equal((await handle(big)).status, 413);
	const malformed = await handle(
		new Request("https://docs.example/mcp", {
			method: "POST",
			body: "{",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
		}),
	);
	assert.equal(malformed.status, 400);
});

test("catalog retains the hosting subpath in all published URLs", () => {
	const nested = createCatalog(inputs, "https://anara.com/lector");
	assert.equal(nested.manifest.mcpUrl, "https://anara.com/lector/mcp");
	for (const doc of nested.docs) {
		assert.ok(doc.url.startsWith("https://anara.com/lector/docs"));
		assert.ok(doc.markdownUrl.startsWith("https://anara.com/lector/docs/"));
	}
	assert.ok(nested.llms.includes("https://anara.com/lector/llms-full.txt"));
	assert.ok(nested.llms.includes("https://anara.com/lector/llms.json"));
});
