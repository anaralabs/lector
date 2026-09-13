import { defineConfig, defineDocs } from "fumadocs-mdx/config";

import { remarkAgentMarkdown } from "./lib/remark-agent-markdown";

export const { docs, meta } = defineDocs({
	dir: "content/docs",
});

export default defineConfig({
	mdxOptions: {
		remarkPlugins: [remarkAgentMarkdown],
		valueToExport: ["agentMarkdown"],
	},
});
