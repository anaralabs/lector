import type { MetadataRoute } from "next";
import { catalog, docsSiteUrl } from "@/lib/agent-docs/source";

export default function sitemap(): MetadataRoute.Sitemap {
	return [
		{ url: docsSiteUrl },
		...catalog.docs.map((doc) => ({ url: doc.url })),
	];
}
