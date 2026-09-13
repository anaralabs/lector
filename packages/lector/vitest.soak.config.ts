import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import config from "./vitest.config";

const mobile = process.env.LECTOR_SOAK_PROFILE === "mobile";
const cycles = Math.max(1, Number(process.env.LECTOR_SOAK_CYCLES) || 3);
export default defineConfig({
	...config,
	define: {
		__LECTOR_SOAK_CYCLES__: cycles,
		__LECTOR_SOAK_CPU_RATE__:
			Number(process.env.LECTOR_SOAK_CPU_RATE) || (mobile ? 4 : 1),
	},
	test: {
		...config.test,
		include: ["benchmarks/reader-soak.browser.test.tsx"],
		testTimeout: Math.max(120000, cycles * 30000),
		browser: {
			...config.test!.browser,
			viewport: { width: mobile ? 390 : 1100, height: mobile ? 700 : 800 },
			provider: playwright({
				launchOptions: {
					channel:
						process.env.LECTOR_BROWSER_CHANNEL ??
						(process.env.CI ? undefined : "chrome"),
				},
				contextOptions: mobile
					? {
							deviceScaleFactor: 3,
							hasTouch: true,
							isMobile: true,
							screen: { width: 390, height: 844 },
							userAgent:
								"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
						}
					: { deviceScaleFactor: 1 },
			}),
			instances: [{ browser: "chromium" }],
		},
	},
});
