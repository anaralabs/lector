import { baseUrl, createMetadata } from "@/lib/metadata";
import "./global.css";
import { RootProvider } from "fumadocs-ui/provider";
import type { Viewport } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";

const inter = Inter({
	subsets: ["latin"],
});

export default function Layout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className={inter.className} suppressHydrationWarning>
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
