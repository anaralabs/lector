import { defineConfig } from "vitest/config";
import config from "./vitest.config";
export default defineConfig({
	...config,
	test: {
		...config.test,
		include: ["benchmarks/**/*.browser.test.tsx"],
		exclude: [
			"benchmarks/reader-soak.browser.test.tsx",
			"benchmarks/scroll-profile.browser.test.tsx",
		],
		testTimeout: 60000,
	},
});
