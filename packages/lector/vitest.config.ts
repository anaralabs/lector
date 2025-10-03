import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],

	test: {
		browser: {
			enabled: true,
			name: "chrome",
			provider: "webdriverio",
			// https://playwright.dev
			providerOptions: {},
		},
	},
});
