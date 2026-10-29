import { defineConfig } from "vite";

export default defineConfig({
	server: { port: 5199, strictPort: true, fs: { allow: [".."] } },
	worker: { format: "es" },
	build: { target: "es2022" },
	optimizeDeps: { exclude: ["@embedpdf/pdfium"] },
});
