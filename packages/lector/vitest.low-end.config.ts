import { defineConfig } from "vitest/config";
import config from "./vitest.soak.config";
export default defineConfig({
	...config,
	test: {
		...config.test,
		include: ["benchmarks/low-end-search.browser.test.tsx"],
	},
});
