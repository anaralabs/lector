import react from "@vitejs/plugin-react";
import type {} from "@vitest/browser/providers/playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	resolve: { dedupe: ["react", "react-dom"] },

	optimizeDeps: {
		include: [
			"pdfjs-dist/legacy/build/pdf.mjs",
			"clsx",
			"@tanstack/react-virtual",
			"use-debounce",
			"@use-gesture/react",
		],
	},
	test: {
		fileParallelism: false,
		include: [
			"tests/**/*.browser.test.tsx",
			"src/**/*.test.ts",
			"src/**/*.test.tsx",
		],
		browser: {
			enabled: true,
			provider: "playwright",
			headless: true,
			screenshotFailures: false,
			instances: [
				{
					browser: "chromium",
					launch: {
						channel:
							process.env.LECTOR_BROWSER_CHANNEL ??
							(process.env.CI ? undefined : "chrome"),
					},
				},
			],
		},
	},
});
