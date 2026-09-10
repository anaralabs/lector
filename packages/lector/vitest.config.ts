import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	optimizeDeps: { include: ["react/jsx-dev-runtime"] },

	test: {
		browser: {
			enabled: true,
			name: "chromium",
			provider: "playwright",
			headless: true,
			providerOptions: {
				launch: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
					? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
					: {},
			},
		},
	},
});
