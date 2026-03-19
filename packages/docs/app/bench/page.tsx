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
import { useEffect, useState } from "react";

const PDF_FILES = [
	{ name: "pathways", url: "/pdf/pathways.pdf" },
	{ name: "large", url: "/pdf/large.pdf" },
	{ name: "links", url: "/pdf/links.pdf" },
	{ name: "form", url: "/pdf/form.pdf" },
	{ name: "quantum", url: "/pdf/quantum.pdf" },
];

const DARK_MODE_FILTERS =
	"invert-[91%] hue-rotate-180 brightness-[80%] contrast-[228%]";

function BenchViewer({
	pdfUrl,
	darkMode,
}: {
	pdfUrl: string;
	darkMode: boolean;
}) {
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
				data-bench-id="pages"
			>
				<Page>
					<CanvasLayer />
					<TextLayer />
				</Page>
			</Pages>
		</Root>
	);
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)]!;
}

export default function BenchPage() {
	const [selectedPdf, setSelectedPdf] = useState(0);
	const [darkMode, setDarkMode] = useState(false);

	useEffect(() => {
		let frameTimes: number[] = [];
		let rafId = 0;
		let lastTs = 0;
		let recording = false;

		const api = {
			pdfFiles: PDF_FILES,

			selectPdf: (index: number) => {
				window.dispatchEvent(
					new CustomEvent("bench-select-pdf", { detail: index }),
				);
			},

			setDarkMode: (on: boolean) => {
				window.dispatchEvent(new CustomEvent("bench-set-dark", { detail: on }));
			},

			getScrollInfo: () => {
				const el = document.querySelector('[data-bench-id="pages"]');
				if (!el) return null;
				return {
					scrollTop: el.scrollTop,
					scrollHeight: el.scrollHeight,
					clientHeight: el.clientHeight,
					maxScroll: el.scrollHeight - el.clientHeight,
				};
			},

			getTextLayerStatus: () => {
				const tls = document.querySelectorAll(".textLayer");
				const pages: { page: string; spans: number }[] = [];
				tls.forEach((tl) => {
					pages.push({
						page: tl.getAttribute("data-page-number") ?? "?",
						spans: tl.querySelectorAll("span").length,
					});
				});
				return {
					count: tls.length,
					totalSpans: pages.reduce((s, p) => s + p.spans, 0),
					pages,
				};
			},

			startFrameRecording: () => {
				frameTimes = [];
				lastTs = performance.now();
				recording = true;
				const loop = () => {
					if (!recording) return;
					const now = performance.now();
					frameTimes.push(now - lastTs);
					lastTs = now;
					rafId = requestAnimationFrame(loop);
				};
				rafId = requestAnimationFrame(loop);
			},

			stopFrameRecording: () => {
				recording = false;
				cancelAnimationFrame(rafId);

				if (frameTimes.length < 2) {
					return {
						totalFrames: frameTimes.length,
						p50: 0,
						p95: 0,
						p99: 0,
						droppedFrames: 0,
						slowFrames: 0,
						frameTimes: [],
					};
				}

				// First frame is always noisy (time since rAF was scheduled), skip it
				const times = frameTimes.slice(1);
				const sorted = [...times].sort((a, b) => a - b);

				return {
					totalFrames: times.length,
					p50: Math.round(percentile(sorted, 50) * 100) / 100,
					p95: Math.round(percentile(sorted, 95) * 100) / 100,
					p99: Math.round(percentile(sorted, 99) * 100) / 100,
					droppedFrames: times.filter((t) => t > 33.3).length,
					slowFrames: times.filter((t) => t > 16.7).length,
					frameTimes: times.map((t) => Math.round(t * 100) / 100),
				};
			},

			scrollTo: (ratio: number) => {
				const el = document.querySelector('[data-bench-id="pages"]');
				if (!el) return;
				el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
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
			recording = false;
			cancelAnimationFrame(rafId);
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
					Playwright: <code>node bench.mjs</code>
				</div>
			</div>
			<div className="flex-1 min-h-0">
				<BenchViewer pdfUrl={PDF_FILES[selectedPdf]!.url} darkMode={darkMode} />
			</div>
		</div>
	);
}
