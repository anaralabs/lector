"use client";

import {
	CanvasLayer,
	CurrentZoom,
	Page,
	Pages,
	Root,
	TextLayer,
	ZoomIn,
	ZoomOut,
} from "@anaralabs/lector";
import "@/lib/setup";
import { useCallback, useEffect, useRef, useState } from "react";

const PDF_FILES = [
	{ name: "pathways", url: "/pdf/pathways.pdf" },
	{ name: "large", url: "/pdf/large.pdf" },
	{ name: "links", url: "/pdf/links.pdf" },
	{ name: "form", url: "/pdf/form.pdf" },
	{ name: "quantum", url: "/pdf/quantum.pdf" },
];

type BenchResult = {
	test: string;
	pdf: string;
	durationMs: number;
	frames: number;
	avgFps: number;
	layoutShifts: number;
	longTasks: number;
	longTaskTotalMs: number;
};

const DARK_MODE_FILTERS =
	"invert-[91%] hue-rotate-180 brightness-[80%] contrast-[228%]";

function BenchViewer({
	pdfUrl,
	darkMode,
}: { pdfUrl: string; darkMode: boolean }) {
	return (
		<Root
			source={pdfUrl}
			className="w-full h-full border rounded-md overflow-hidden relative flex flex-col"
			loader={<div className="p-4">Loading...</div>}
		>
			<div className="bg-gray-100 dark:bg-gray-800 border-b p-1 flex items-center justify-center text-sm gap-2 shrink-0">
				<ZoomOut className="px-3 py-1 -mr-2">-</ZoomOut>
				<CurrentZoom className="bg-white dark:bg-gray-700 rounded-full px-3 py-1 border text-center w-16" />
				<ZoomIn className="px-3 py-1 -ml-2">+</ZoomIn>
			</div>
			<Pages
				className={`p-2 h-full ${darkMode ? DARK_MODE_FILTERS : ""}`}
				id="bench-pages"
			>
				<Page>
					<CanvasLayer />
					<TextLayer />
				</Page>
			</Pages>
		</Root>
	);
}

export default function BenchPage() {
	const [selectedPdf, setSelectedPdf] = useState(0);
	const [darkMode, setDarkMode] = useState(false);
	const [results, setResults] = useState<BenchResult[]>([]);
	const [running, setRunning] = useState(false);
	const resultsRef = useRef<BenchResult[]>([]);

	const addResult = useCallback((r: BenchResult) => {
		resultsRef.current = [...resultsRef.current, r];
		setResults([...resultsRef.current]);
	}, []);

	useEffect(() => {
		// Expose bench API on window for Chrome DevTools MCP
		const api = {
			// Scroll the PDF container to a given ratio (0-1)
			scrollTo: (ratio: number) => {
				const el = document.querySelector("#bench-pages");
				if (!el) return;
				el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
			},

			// Get scroll dimensions
			getScrollInfo: () => {
				const el = document.querySelector("#bench-pages");
				if (!el) return null;
				return {
					scrollTop: el.scrollTop,
					scrollHeight: el.scrollHeight,
					clientHeight: el.clientHeight,
					maxScroll: el.scrollHeight - el.clientHeight,
				};
			},

			// Run a fast-scroll benchmark: scroll from top to bottom in steps
			runScrollBench: async (steps = 40, delayMs = 50) => {
				const el = document.querySelector("#bench-pages");
				if (!el) return null;

				const maxScroll = el.scrollHeight - el.clientHeight;
				if (maxScroll <= 0) return null;

				let frames = 0;
				let layoutShifts = 0;
				let longTasks = 0;
				let longTaskTotalMs = 0;

				const clsObserver = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						if (entry.entryType === "layout-shift") {
							layoutShifts++;
						}
					}
				});

				const ltObserver = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						longTasks++;
						longTaskTotalMs += entry.duration;
					}
				});

				try { clsObserver.observe({ type: "layout-shift", buffered: false }); } catch {}
				try { ltObserver.observe({ type: "longtask", buffered: false }); } catch {}

				const countFrame = () => { frames++; };

				const start = performance.now();
				el.scrollTop = 0;

				await new Promise<void>((resolve) => {
					let step = 0;
					const tick = () => {
						requestAnimationFrame(countFrame);
						if (step >= steps) {
							resolve();
							return;
						}
						el.scrollTop = (step / steps) * maxScroll;
						step++;
						setTimeout(tick, delayMs);
					};
					tick();
				});

				// Scroll back up
				await new Promise<void>((resolve) => {
					let step = 0;
					const tick = () => {
						requestAnimationFrame(countFrame);
						if (step >= steps) {
							resolve();
							return;
						}
						el.scrollTop = ((steps - step) / steps) * maxScroll;
						step++;
						setTimeout(tick, delayMs);
					};
					tick();
				});

				const duration = performance.now() - start;

				clsObserver.disconnect();
				ltObserver.disconnect();

				return {
					durationMs: Math.round(duration),
					frames,
					avgFps: Math.round((frames / duration) * 1000),
					layoutShifts,
					longTasks,
					longTaskTotalMs: Math.round(longTaskTotalMs),
				};
			},

			// Run a zoom benchmark: zoom in and out in steps
			runZoomBench: async (steps = 10, delayMs = 100) => {
				const zoomIn = document.querySelector("[data-testid='zoom-in']") as HTMLButtonElement
					?? document.querySelectorAll("button")[0];
				const zoomOut = document.querySelector("[data-testid='zoom-out']") as HTMLButtonElement
					?? document.querySelectorAll("button")[1];

				// Find zoom buttons by text content
				const allButtons = Array.from(document.querySelectorAll("button"));
				const plusBtn = allButtons.find(b => b.textContent?.trim() === "+");
				const minusBtn = allButtons.find(b => b.textContent?.trim() === "-");

				if (!plusBtn || !minusBtn) return { error: "Zoom buttons not found" };

				let frames = 0;
				let longTasks = 0;
				let longTaskTotalMs = 0;

				const ltObserver = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						longTasks++;
						longTaskTotalMs += entry.duration;
					}
				});
				try { ltObserver.observe({ type: "longtask", buffered: false }); } catch {}

				const countFrame = () => { frames++; };

				const start = performance.now();

				// Zoom in
				for (let i = 0; i < steps; i++) {
					requestAnimationFrame(countFrame);
					plusBtn.click();
					await new Promise(r => setTimeout(r, delayMs));
				}

				// Zoom out
				for (let i = 0; i < steps * 2; i++) {
					requestAnimationFrame(countFrame);
					minusBtn.click();
					await new Promise(r => setTimeout(r, delayMs));
				}

				// Zoom back to original
				for (let i = 0; i < steps; i++) {
					requestAnimationFrame(countFrame);
					plusBtn.click();
					await new Promise(r => setTimeout(r, delayMs));
				}

				const duration = performance.now() - start;
				ltObserver.disconnect();

				return {
					durationMs: Math.round(duration),
					frames,
					avgFps: Math.round((frames / duration) * 1000),
					longTasks,
					longTaskTotalMs: Math.round(longTaskTotalMs),
				};
			},

			// Simulate pinch zoom via wheel events with ctrl
			runPinchZoomBench: async (cycles = 3, stepsPerCycle = 8, delayMs = 60) => {
				const el = document.querySelector("#bench-pages");
				if (!el) return { error: "Container not found" };

				let frames = 0;
				let longTasks = 0;
				let longTaskTotalMs = 0;

				const ltObserver = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						longTasks++;
						longTaskTotalMs += entry.duration;
					}
				});
				try { ltObserver.observe({ type: "longtask", buffered: false }); } catch {}
				const countFrame = () => { frames++; };

				const rect = el.getBoundingClientRect();
				const cx = rect.left + rect.width / 2;
				const cy = rect.top + rect.height / 2;

				const start = performance.now();

				for (let c = 0; c < cycles; c++) {
					// Pinch zoom in
					for (let i = 0; i < stepsPerCycle; i++) {
						requestAnimationFrame(countFrame);
						el.dispatchEvent(new WheelEvent("wheel", {
							deltaY: -50, ctrlKey: true, bubbles: true,
							clientX: cx, clientY: cy,
						}));
						await new Promise(r => setTimeout(r, delayMs));
					}
					// Pinch zoom out
					for (let i = 0; i < stepsPerCycle; i++) {
						requestAnimationFrame(countFrame);
						el.dispatchEvent(new WheelEvent("wheel", {
							deltaY: 50, ctrlKey: true, bubbles: true,
							clientX: cx, clientY: cy,
						}));
						await new Promise(r => setTimeout(r, delayMs));
					}
				}

				const duration = performance.now() - start;
				ltObserver.disconnect();

				return {
					durationMs: Math.round(duration),
					frames,
					avgFps: Math.round((frames / duration) * 1000),
					longTasks,
					longTaskTotalMs: Math.round(longTaskTotalMs),
				};
			},

			// Get current results from the page
			getResults: () => resultsRef.current,

			// Select a PDF by index
			selectPdf: (index: number) => {
				const event = new CustomEvent("bench-select-pdf", { detail: index });
				window.dispatchEvent(event);
			},

			// Toggle dark mode CSS filters
			setDarkMode: (on: boolean) => {
				window.dispatchEvent(
					new CustomEvent("bench-set-dark", { detail: on }),
				);
			},

			// Full suite: run all tests on all PDFs, both light and dark mode
			runFullSuite: async () => {
				const allResults: BenchResult[] = [];
				for (const mode of ["light", "dark"] as const) {
					api.setDarkMode(mode === "dark");
					await new Promise(r => setTimeout(r, 500));

					for (let pi = 0; pi < PDF_FILES.length; pi++) {
						api.selectPdf(pi);
						await new Promise(r => setTimeout(r, 2000));

						const pdfName = `${PDF_FILES[pi]!.name}:${mode}`;

						const scrollResult = await api.runScrollBench(30, 40);
						if (scrollResult) {
							allResults.push({ test: "fast-scroll", pdf: pdfName, ...scrollResult });
						}

						await new Promise(r => setTimeout(r, 500));

						const zoomResult = await api.runZoomBench(8, 80);
						if (zoomResult && !("error" in zoomResult)) {
							allResults.push({ test: "button-zoom", pdf: pdfName, layoutShifts: 0, ...zoomResult });
						}

						await new Promise(r => setTimeout(r, 500));

						const pinchResult = await api.runPinchZoomBench(2, 6, 60);
						if (pinchResult && !("error" in pinchResult)) {
							allResults.push({ test: "pinch-zoom", pdf: pdfName, layoutShifts: 0, ...pinchResult });
						}

						await new Promise(r => setTimeout(r, 500));
					}
				}
				api.setDarkMode(false);
				return allResults;
			},
		};

		(window as any).__bench = api;

		const handleSelectPdf = (e: Event) => {
			const idx = (e as CustomEvent).detail;
			if (typeof idx === "number" && idx >= 0 && idx < PDF_FILES.length) {
				setSelectedPdf(idx);
			}
		};
		const handleSetDark = (e: Event) => {
			setDarkMode(!!(e as CustomEvent).detail);
		};
		window.addEventListener("bench-select-pdf", handleSelectPdf);
		window.addEventListener("bench-set-dark", handleSetDark);
		return () => {
			window.removeEventListener("bench-select-pdf", handleSelectPdf);
			window.removeEventListener("bench-set-dark", handleSetDark);
		};
	}, []);

	return (
		<div className="flex flex-col h-screen">
			<div className="bg-gray-50 dark:bg-gray-900 border-b p-3 flex items-center gap-4 shrink-0">
				<span className="font-semibold text-sm">Bench</span>
				<div className="flex gap-1">
					{PDF_FILES.map((pdf, i) => (
						<button
							key={pdf.name}
							onClick={() => setSelectedPdf(i)}
							className={`px-3 py-1 text-xs rounded ${i === selectedPdf ? "bg-blue-600 text-white" : "bg-gray-200 dark:bg-gray-700"}`}
						>
							{pdf.name}
						</button>
					))}
				</div>
				<button
					onClick={() => setDarkMode((d) => !d)}
					className={`px-3 py-1 text-xs rounded ${darkMode ? "bg-yellow-500 text-black" : "bg-gray-700 text-white"}`}
				>
					{darkMode ? "Light" : "Dark"}
				</button>
				<div className="text-xs text-gray-500 ml-auto">
					Open DevTools console → <code>__bench.runFullSuite()</code>
				</div>
			</div>
			<div className="flex-1 min-h-0">
				<BenchViewer pdfUrl={PDF_FILES[selectedPdf]!.url} darkMode={darkMode} />
			</div>
			{results.length > 0 && (
				<div className="border-t p-2 max-h-48 overflow-auto text-xs font-mono bg-gray-50 dark:bg-gray-900">
					<pre id="bench-results">{JSON.stringify(results, null, 2)}</pre>
				</div>
			)}
		</div>
	);
}
