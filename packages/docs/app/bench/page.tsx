"use client";

import {
	AnnotationHighlightLayer,
	AnnotationLayer,
	CanvasLayer,
	HighlightLayer,
	Page,
	Pages,
	Root,
	SelectionTooltip,
	TextLayer,
} from "@anaralabs/lector";
import "@/lib/setup";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useEffect, useRef } from "react";

type LayerConfig = {
	canvas: boolean;
	text: boolean;
	annotation: boolean;
	annotationHighlight: boolean;
	highlight: boolean;
	selectionTooltip: boolean;
};

const PDFS: Record<string, string> = {
	pathways: "/pdf/pathways.pdf",
	large: "/pdf/large.pdf",
	links: "/pdf/links.pdf",
	form: "/pdf/form.pdf",
	expensive: "/pdf/expensive.pdf",
};

function parseLayers(param: string | null): LayerConfig {
	if (!param || param === "all") {
		return {
			canvas: true,
			text: true,
			annotation: true,
			annotationHighlight: true,
			highlight: true,
			selectionTooltip: true,
		};
	}
	if (param === "minimal") {
		return {
			canvas: true,
			text: true,
			annotation: false,
			annotationHighlight: false,
			highlight: false,
			selectionTooltip: false,
		};
	}
	const set = new Set(param.split(","));
	return {
		canvas: set.has("canvas"),
		text: set.has("text"),
		annotation: set.has("annotation"),
		annotationHighlight: set.has("annotationHighlight"),
		highlight: set.has("highlight"),
		selectionTooltip: set.has("selectionTooltip"),
	};
}

interface FlickResult {
	frames: number;
	avg: string;
	p50: string;
	p95: string;
	max: string;
	over50: number;
	over100: number;
}

interface LayerStats {
	canvases: number;
	textLayers: number;
	annotationLayers: number;
	totalDOMNodes: number;
	pagesInDOM: number;
}

declare global {
	interface Window {
		__bench?: {
			fastFlick: (stepPx?: number) => Promise<FlickResult>;
			getLayerStats: () => LayerStats;
			waitForTextLayer: (pageNum: number, timeoutMs?: number) => Promise<boolean>;
			layers: LayerConfig;
		};
	}
}

function useBenchAPI(layers: LayerConfig) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const getContainer = (): HTMLDivElement | null => {
			if (containerRef.current) return containerRef.current;
			for (const d of document.querySelectorAll("div")) {
				const s = getComputedStyle(d);
				if (
					s.overflow === "auto" &&
					d.scrollHeight > d.clientHeight + 500
				) {
					containerRef.current = d as HTMLDivElement;
					return d as HTMLDivElement;
				}
			}
			return null;
		};

		const fastFlick = (stepPx = 800): Promise<FlickResult> => {
			const c = getContainer();
			if (!c)
				return Promise.resolve({
					frames: 0,
					avg: "0",
					p50: "0",
					p95: "0",
					max: "0",
					over50: 0,
					over100: 0,
				});
			c.scrollTop = 0;
			return new Promise((resolve) => {
				setTimeout(() => {
					const fps: number[] = [];
					let lastT = performance.now();
					let pos = 0;
					let fc = 0;
					const maxScroll = c.scrollHeight - c.clientHeight;
					const step = (ts: number) => {
						const dt = ts - lastT;
						lastT = ts;
						if (dt > 0 && fc > 0) fps.push(dt);
						fc++;
						pos += stepPx;
						c.scrollTop = pos;
						if (pos < maxScroll && fc < 300) {
							requestAnimationFrame(step);
						} else {
							const sorted = [...fps].sort((a, b) => a - b);
							resolve({
								frames: fps.length,
								avg: (
									sorted.reduce((a, b) => a + b, 0) / sorted.length
								).toFixed(1),
								p50:
									sorted[Math.floor(sorted.length * 0.5)]?.toFixed(
										1,
									) ?? "0",
								p95:
									sorted[Math.floor(sorted.length * 0.95)]?.toFixed(
										1,
									) ?? "0",
								max: sorted[sorted.length - 1]?.toFixed(1) ?? "0",
								over50: fps.filter((f) => f > 50).length,
								over100: fps.filter((f) => f > 100).length,
							});
						}
					};
					requestAnimationFrame(step);
				}, 500);
			});
		};

		const getLayerStats = (): LayerStats => {
			const c = getContainer();
			if (!c)
				return {
					canvases: 0,
					textLayers: 0,
					annotationLayers: 0,
					totalDOMNodes: 0,
					pagesInDOM: 0,
				};
			return {
				canvases: c.querySelectorAll("canvas").length,
				textLayers: c.querySelectorAll(".textLayer").length,
				annotationLayers: c.querySelectorAll(".annotationLayer").length,
				totalDOMNodes: c.querySelectorAll("*").length,
				pagesInDOM: new Set(
					Array.from(c.querySelectorAll("[data-page-number]")).map((el) =>
						el.getAttribute("data-page-number"),
					),
				).size,
			};
		};

		const waitForTextLayer = (
			pageNum: number,
			timeoutMs = 5000,
		): Promise<boolean> => {
			const c = getContainer();
			if (!c) return Promise.resolve(false);
			return new Promise((resolve) => {
				const deadline = Date.now() + timeoutMs;
				const check = () => {
					const tl = c.querySelector(
						`.textLayer[data-page-number="${pageNum}"]`,
					);
					if (tl && tl.childNodes.length > 1) {
						resolve(true);
					} else if (Date.now() > deadline) {
						resolve(false);
					} else {
						requestAnimationFrame(check);
					}
				};
				check();
			});
		};

		window.__bench = { fastFlick, getLayerStats, waitForTextLayer, layers };
		return () => {
			delete window.__bench;
		};
	}, [layers]);
}

export default function BenchPage() {
	return (
		<Suspense
			fallback={
				<div className="h-screen w-screen bg-neutral-900 flex items-center justify-center text-white">
					Loading...
				</div>
			}
		>
			<BenchContent />
		</Suspense>
	);
}

function BenchContent() {
	const searchParams = useSearchParams();
	const pdfKey = searchParams.get("pdf") ?? "pathways";
	const pdfUrl = PDFS[pdfKey] ?? PDFS.pathways;
	const layers = useMemo(
		() => parseLayers(searchParams.get("layers")),
		[searchParams],
	);

	useBenchAPI(layers);

	const enabledNames = Object.entries(layers)
		.filter(([, v]) => v)
		.map(([k]) => k)
		.join(", ");

	return (
		<div className="h-screen w-screen bg-neutral-900 flex flex-col">
			<div className="p-2 text-white text-xs flex gap-4 items-center bg-neutral-800 shrink-0 font-mono">
				<span className="text-green-400">bench</span>
				<span className="text-neutral-500">|</span>
				<span className="text-neutral-400">{pdfKey}</span>
				<span className="text-neutral-500">|</span>
				<span className="text-blue-400">layers: {enabledNames}</span>
			</div>
			<div className="flex-1 overflow-hidden">
				<Root
					isZoomFitWidth
					source={pdfUrl}
					className="h-full overflow-hidden relative bg-neutral-900"
					loader={
						<div className="flex items-center justify-center h-full text-white">
							Loading...
						</div>
					}
				>
					<Pages
						className="w-full"
						style={{ scrollbarWidth: "thin" }}
						virtualizerOptions={{ overscan: 2 }}
					>
						<Page>
							{layers.canvas && <CanvasLayer />}
							{layers.text && <TextLayer />}
							{layers.annotation && (
								<AnnotationLayer
									externalLinksEnabled
									jumpOptions={{ behavior: "smooth", align: "start" }}
								/>
							)}
							{layers.annotationHighlight && (
								<AnnotationHighlightLayer
									highlightClassName="mix-blend-multiply"
									underlineClassName="!h-0.5"
								/>
							)}
							{layers.highlight && (
								<HighlightLayer className="z-10 mix-blend-multiply" />
							)}
						</Page>
					</Pages>
					{layers.selectionTooltip && (
						<SelectionTooltip>
							<div className="bg-white rounded shadow px-2 py-1 text-sm">
								Selection
							</div>
						</SelectionTooltip>
					)}
				</Root>
			</div>
		</div>
	);
}
