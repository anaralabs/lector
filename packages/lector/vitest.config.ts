import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const browser =
	process.env.LECTOR_TEST_BROWSER === "webkit"
		? "webkit"
		: process.env.LECTOR_TEST_BROWSER === "firefox"
			? "firefox"
			: "chromium";

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
			"@floating-ui/react",
			"zustand/react/shallow",
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
			provider: playwright(),
			headless: true,
			screenshotFailures: false,
			instances: [
				{
					browser,
					launch: {
						channel:
							browser === "chromium"
								? (process.env.LECTOR_BROWSER_CHANNEL ??
									(process.env.CI ? undefined : "chrome"))
								: undefined,
					},
				},
			],
		},
	},
});
