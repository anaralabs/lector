import { baseUrl, createMetadata } from "@/lib/metadata";
import "./global.css";
import { RootProvider } from "fumadocs-ui/provider";
import type { Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

const inter = localFont({
	src: "../public/fonts/InterVariable.woff2",
	display: "swap",
	weight: "100 900",
	style: "normal",
	variable: "--font-inter",
});

export default function Layout({ children }: { children: ReactNode }) {
	return (
		<html
			lang="en"
			className={`${inter.className} ${inter.variable}`}
			suppressHydrationWarning
		>
			<body className="flex flex-col min-h-screen">
				<RootProvider>{children}</RootProvider>
			</body>
		</html>
	);
}

export const metadata = createMetadata({
	title: {
		template: "%s | Lector",
		default: "Lector",
	},
	description: "Headless React PDF viewer for the web",
	metadataBase: baseUrl,
});

export const viewport: Viewport = {
	themeColor: [
		{ media: "(prefers-color-scheme: dark)", color: "#0A0A0A" },
		{ media: "(prefers-color-scheme: light)", color: "#fff" },
	],
};
