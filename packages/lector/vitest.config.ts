import react from "@vitejs/plugin-react";
import type {} from "@vitest/browser/providers/playwright";
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
			"zustand/react/shallow",
			"@tanstack/react-virtual",
			"clsx",
			"use-debounce",
			"@use-gesture/react",
			"@floating-ui/react",
		],
	},
	test: {
		include: [
			"tests/**/*.browser.test.tsx",
			"src/**/*.test.ts",
			"src/**/*.test.tsx",
		],
		browser: {
			enabled: true,
			name: browser,
			provider: "playwright",
			headless: true,
			screenshotFailures: false,
			viewport: { width: 2000, height: 1000 },
			providerOptions: {
				context: { viewport: { width: 2100, height: 1100 } },
				launch: {
					channel:
						browser === "chromium"
							? (process.env.LECTOR_BROWSER_CHANNEL ??
								(process.env.CI ? undefined : "chrome"))
							: undefined,
				},
			},
			commands: {
				async mouse(context, action: string, x = 0, y = 0, shift = false) {
					const { page, iframe } = context as unknown as {
						page: import("playwright").Page;
						iframe: import("playwright").FrameLocator;
					};
					const box = await iframe.locator("body").boundingBox();
					if (shift) await page.keyboard.down("Shift");
					if (action === "down") {
						await page.mouse.move(x + (box?.x ?? 0), y + (box?.y ?? 0));
						await page.mouse.down();
					}
					if (action === "move")
						await page.mouse.move(x + (box?.x ?? 0), y + (box?.y ?? 0), {
							steps: 8,
						});
					if (action === "up") await page.mouse.up();
					if (action === "click")
						await page.mouse.click(x + (box?.x ?? 0), y + (box?.y ?? 0));
					if (action === "double")
						await page.mouse.dblclick(x + (box?.x ?? 0), y + (box?.y ?? 0));
					if (shift) await page.keyboard.up("Shift");
				},
			},
		},
	},
});
