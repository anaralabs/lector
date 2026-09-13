import { documentationResponse } from "@/lib/agent-docs/response";
import { catalog } from "@/lib/agent-docs/source";
export const dynamic = "force-static";
export const dynamicParams = false;
export function generateStaticParams() {
	return catalog.docs.map((doc) => ({ slug: doc.slug.split("/") }));
}
export async function GET(
	_request: Request,
	context: { params: Promise<{ slug: string[] }> },
) {
	const { slug } = await context.params;
	const doc = catalog.get(slug.join("/"));
	if (!doc)
		return new Response("Documentation page not found", { status: 404 });
	return documentationResponse(doc.markdown);
}
