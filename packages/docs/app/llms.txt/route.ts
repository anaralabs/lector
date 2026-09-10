import { documentationResponse } from "@/lib/agent-docs/response";
import { catalog } from "@/lib/agent-docs/source";
export const dynamic = "force-static";
export function GET() {
	return documentationResponse(catalog.llms, "text/plain");
}
