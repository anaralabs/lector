import { createMDX } from "fumadocs-mdx/next";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
	reactStrictMode: true,
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
