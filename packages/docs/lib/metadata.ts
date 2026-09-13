import type { Metadata } from "next/types";

export function createMetadata(override: Metadata): Metadata {
	return {
		...override,
		openGraph: {
			title: override.title ?? undefined,
			description: override.description ?? undefined,
			url: "https://anara.com/lector",
			images: "https://anara.com/lector/banner.png",
			siteName: "Fumadocs",
			...override.openGraph,
		},
		twitter: {
			card: "summary_large_image",
			creator: "@andrewdorobantu",
			title: override.title ?? undefined,
			description: override.description ?? undefined,
			images: "https://anara.com/lector/banner.png",
			...override.twitter,
		},
	};
}

export const baseUrl = new URL("https://anara.com");
