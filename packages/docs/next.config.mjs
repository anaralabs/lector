import { createMDX } from "fumadocs-mdx/next";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
	reactStrictMode: true,
	basePath: "/lector",
	async redirects() {
		return [
			{
				source: "/lector/:path*",
				destination: "https://anara.com/lector/:path*",
				has: [{ type: "host", value: "lector.anara.com" }],
				basePath: false,
				permanent: true,
			},
			{
				source: "/:path*",
				destination: "https://anara.com/lector/:path*",
				has: [{ type: "host", value: "lector.anara.com" }],
				basePath: false,
				permanent: true,
			},
			{
				source: "/",
				destination: "/lector",
				basePath: false,
				permanent: false,
			},
		];
	},
	async rewrites() {
		return {
			beforeFiles: [
				{ source: "/docs/:slug*.md", destination: "/api/docs/:slug*" },
			],
		};
	},
	serverExternalPackages: ["pdfjs-dist"],
	webpack: (config, { dev }) => {
		if (dev) {
			config.module.rules.unshift({
				test: /pdfjs-dist[/\\].*\.mjs$/,
				enforce: "pre",
				loader: resolve(__dirname, "lib/pdfjs-webpack-patch.cjs"),
			});
		}
		return config;
	},
};

export default withMDX(config);
