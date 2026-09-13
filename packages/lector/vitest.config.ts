import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { selectionPointer } from "./tests/selection-commands";

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
			"react/jsx-dev-runtime",
			"@testing-library/react",
			"zustand",
			"pdfjs-dist/legacy/build/pdf.mjs",
			"clsx",
			"@tanstack/react-virtual",
			"use-debounce",
			"@use-gesture/react",
			"@floating-ui/react",
			"zustand/react/shallow",
			"zustand/vanilla",
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
			// Windows runners can reserve Vitest's default high port (63315).
			api:
				process.platform === "win32"
					? { host: "127.0.0.1", port: 3100 }
					: undefined,
			commands: {
				selectionPointer,
				async mouse(context, action: string, x = 0, y = 0, shift = false) {
					if (shift) await context.page.keyboard.down("Shift");
					try {
						if (action === "up") await context.page.mouse.up();
						else {
							await selectionPointer(context, "move", x, y);
							if (action === "down") await context.page.mouse.down();
							if (action === "click" || action === "double") {
								await context.page.mouse.down({
									clickCount: action === "double" ? 2 : 1,
								});
								await context.page.mouse.up({
									clickCount: action === "double" ? 2 : 1,
								});
							}
						}
					} finally {
						if (shift) await context.page.keyboard.up("Shift");
					}
				},
			},
			provider: playwright({
				launchOptions: {
					executablePath:
						browser === "chromium"
							? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
							: undefined,
					channel:
						browser === "chromium"
							? (process.env.LECTOR_BROWSER_CHANNEL ??
								(process.env.CI ? undefined : "chrome"))
							: undefined,
				},
			}),
			headless: true,
			screenshotFailures: false,
			instances: [{ browser }],
		},
	},
});
