import { createDocsHandler } from "@/lib/agent-docs/mcp";
import { catalog, docsOrigin } from "@/lib/agent-docs/source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const origins = [docsOrigin];
if (process.env.VERCEL_URL)
	origins.push(new URL(`https://${process.env.VERCEL_URL}`).origin);
if (process.env.NODE_ENV === "development")
	origins.push("http://localhost:3000", "http://127.0.0.1:3000");
for (const origin of (process.env.MCP_ALLOWED_ORIGINS ?? "")
	.split(",")
	.filter(Boolean)) {
	origins.push(new URL(origin.trim()).origin);
}
const handle = createDocsHandler(catalog, origins);
export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = handle;
