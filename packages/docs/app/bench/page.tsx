"use client";

import {
	CanvasLayer,
	Page,
	Pages,
	Root,
	TextLayer,
	type TextLayerModeOverride,
} from "@anaralabs/lector";
import { useEffect, useMemo, useRef, useState } from "react";

import "@/lib/setup";

type BenchmarkMode = Exclude<TextLayerModeOverride, "auto">;

type BenchmarkPdfKey = "pathways" | "large" | "research" | "expensive";

type BenchmarkMetric = {
	mode: BenchmarkMode;
	pdf: BenchmarkPdfKey;
	textLayerReadyMs: number | null;
	scrollDurationMs: number | null;
	frameCount: number;
	p50FrameMs: number | null;
	p95FrameMs: number | null;
	framesOver16ms: number;
	framesOver50ms: number;
	framesOver100ms: number;
};

type BenchmarkRunResult = BenchmarkMetric & {
	requestedMode: BenchmarkMode;
	actualMode: string | null;
	fallbackReason: string | null;
};

declare global {
	interface Window {
		__bench?: {
			runComparison: (params?: {
				pdf?: BenchmarkPdfKey;
				modes?: BenchmarkMode[];
				scrollDurationMs?: number;
			}) => Promise<BenchmarkRunResult[]>;
			setMode: (mode: BenchmarkMode) => void;
			setPdf: (pdf: BenchmarkPdfKey) => void;
			getState: () => {
				mode: BenchmarkMode;
				pdf: BenchmarkPdfKey;
			};
		};
	}
}

const PDF_OPTIONS: Record<BenchmarkPdfKey, { label: string; source: string }> =
	{
		pathways: { label: "Pathways", source: "/pdf/pathways.pdf" },
		large: { label: "Large", source: "/pdf/large.pdf" },
		research: { label: "Research Paper", source: "/pdf/2506.13188v1.pdf" },
		expensive: { label: "Expensive", source: "/pdf/expensive.pdf" },
	};

const modeOptions: BenchmarkMode[] = ["pretext", "pdfjs"];

const percentile = (values: number[], ratio: number) => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.floor((sorted.length - 1) * ratio)),
	);
	return sorted[index] ?? null;
};

const BenchmarkViewer = ({
	mode,
	source,
	onTextLayerReady,
}: {
	mode: BenchmarkMode;
	source: string;
	onTextLayerReady?: (payload: {
		requestedMode: BenchmarkMode;
		actualMode: string | null;
		fallbackReason: string | null;
		elapsedMs: number;
	}) => void;
}) => {
	const startTimeRef = useRef<number | null>(null);
	const reportedRef = useRef(false);

	useEffect(() => {
		startTimeRef.current = performance.now();
		reportedRef.current = false;
	}, []);

	useEffect(() => {
		const poll = () => {
			if (reportedRef.current) {
				return;
			}

			const textLayer = document.querySelector(
				"[data-bench-viewer] .textLayer",
			) as HTMLDivElement | null;

			if (!textLayer) {
				requestAnimationFrame(poll);
				return;
			}

			const actualMode = textLayer.getAttribute("data-text-layer-mode");
			const hasSpans = textLayer.querySelector("span");

			if (!actualMode || !hasSpans) {
				requestAnimationFrame(poll);
				return;
			}

			reportedRef.current = true;
			onTextLayerReady?.({
				requestedMode: mode,
				actualMode,
				fallbackReason: textLayer.getAttribute(
					"data-text-layer-fallback-reason",
				),
				elapsedMs:
					performance.now() - (startTimeRef.current ?? performance.now()),
			});
		};

		const frame = requestAnimationFrame(poll);
		return () => cancelAnimationFrame(frame);
	}, [mode, onTextLayerReady]);

	return (
		<div
			data-bench-viewer
			className="rounded-lg border bg-white shadow-sm h-[70vh] overflow-hidden"
		>
			<Root
				source={source}
				className="h-full w-full overflow-hidden rounded-lg border"
				loader={<div className="p-4 text-sm text-gray-500">Loading PDF…</div>}
			>
				<Pages className="h-full bg-gray-100 p-4">
					<Page>
						<CanvasLayer />
						<TextLayer mode={mode} />
					</Page>
				</Pages>
			</Root>
		</div>
	);
};

export default function BenchmarkPage() {
	const [mode, setMode] = useState<BenchmarkMode>("pretext");
	const [pdf, setPdf] = useState<BenchmarkPdfKey>("pathways");
	const [lastMetric, setLastMetric] = useState<BenchmarkRunResult | null>(null);
	const [isRunning, setIsRunning] = useState(false);
	const readyPayloadRef = useRef<{
		requestedMode: BenchmarkMode;
		actualMode: string | null;
		fallbackReason: string | null;
		elapsedMs: number;
	} | null>(null);

	const source = PDF_OPTIONS[pdf].source;

	const runSingleBenchmark = useMemo(
		() =>
			async ({
				nextMode,
				nextPdf,
				scrollDurationMs = 3000,
			}: {
				nextMode: BenchmarkMode;
				nextPdf: BenchmarkPdfKey;
				scrollDurationMs?: number;
			}): Promise<BenchmarkRunResult> => {
				setIsRunning(true);
				readyPayloadRef.current = null;
				setMode(nextMode);
				setPdf(nextPdf);

				await new Promise<void>((resolve) => {
					const waitForReady = () => {
						if (readyPayloadRef.current?.requestedMode === nextMode) {
							resolve();
							return;
						}
						requestAnimationFrame(waitForReady);
					};
					waitForReady();
				});

				const scrollContainer = document.querySelector(
					"[data-bench-viewer] [style*='overflow: auto']",
				) as HTMLDivElement | null;

				if (!scrollContainer) {
					throw new Error("Benchmark scroll container not found");
				}

				scrollContainer.scrollTop = 0;
				await new Promise((resolve) => requestAnimationFrame(resolve));

				const frameTimes: number[] = [];
				let lastTimestamp = performance.now();
				let animationFrameId = 0;
				const startedAt = performance.now();
				const initialScrollTop = scrollContainer.scrollTop;
				const maxScrollTop =
					scrollContainer.scrollHeight - scrollContainer.clientHeight;

				const step = (timestamp: number) => {
					frameTimes.push(timestamp - lastTimestamp);
					lastTimestamp = timestamp;

					const elapsed = timestamp - startedAt;
					const progress = Math.min(1, elapsed / scrollDurationMs);
					scrollContainer.scrollTop =
						initialScrollTop + maxScrollTop * progress;

					if (progress < 1) {
						animationFrameId = requestAnimationFrame(step);
					}
				};

				animationFrameId = requestAnimationFrame(step);
				await new Promise((resolve) =>
					setTimeout(resolve, scrollDurationMs + 100),
				);
				cancelAnimationFrame(animationFrameId);

				const readyPayload = readyPayloadRef.current;
				const metric: BenchmarkRunResult = {
					mode: nextMode,
					pdf: nextPdf,
					requestedMode: nextMode,
					actualMode: readyPayload?.actualMode ?? null,
					fallbackReason: readyPayload?.fallbackReason ?? null,
					textLayerReadyMs: readyPayload?.elapsedMs ?? null,
					scrollDurationMs,
					frameCount: frameTimes.length,
					p50FrameMs: percentile(frameTimes, 0.5),
					p95FrameMs: percentile(frameTimes, 0.95),
					framesOver16ms: frameTimes.filter((value) => value > 16).length,
					framesOver50ms: frameTimes.filter((value) => value > 50).length,
					framesOver100ms: frameTimes.filter((value) => value > 100).length,
				};

				setLastMetric(metric);
				setIsRunning(false);
				return metric;
			},
		[],
	);

	useEffect(() => {
		window.__bench = {
			runComparison: async ({
				pdf: nextPdf = "pathways",
				modes = ["pretext", "pdfjs"],
				scrollDurationMs = 3000,
			} = {}) => {
				const results: BenchmarkRunResult[] = [];
				for (const nextMode of modes) {
					const result = await runSingleBenchmark({
						nextMode,
						nextPdf,
						scrollDurationMs,
					});
					results.push(result);
				}
				return results;
			},
			setMode,
			setPdf,
			getState: () => ({
				mode,
				pdf,
			}),
		};

		return () => {
			delete window.__bench;
		};
	}, [mode, pdf, runSingleBenchmark]);

	return (
		<div className="min-h-screen bg-slate-50 p-6">
			<div className="mx-auto flex max-w-7xl flex-col gap-6">
				<div className="space-y-2">
					<h1 className="text-3xl font-semibold tracking-tight">
						Text Layer Benchmark
					</h1>
					<p className="max-w-3xl text-sm text-slate-600">
						Compare the pretext-based text layer against the native PDF.js text
						layer. Use this page with browser automation + CPU throttling for
						apples-to-apples runs.
					</p>
				</div>

				<div className="grid gap-4 rounded-lg border bg-white p-4 md:grid-cols-3">
					<label className="flex flex-col gap-2 text-sm">
						<span className="font-medium">PDF</span>
						<select
							className="rounded-md border px-3 py-2"
							value={pdf}
							onChange={(event) =>
								setPdf(event.target.value as BenchmarkPdfKey)
							}
							disabled={isRunning}
						>
							{Object.entries(PDF_OPTIONS).map(([value, option]) => (
								<option key={value} value={value}>
									{option.label}
								</option>
							))}
						</select>
					</label>

					<label className="flex flex-col gap-2 text-sm">
						<span className="font-medium">Text layer mode</span>
						<select
							className="rounded-md border px-3 py-2"
							value={mode}
							onChange={(event) => setMode(event.target.value as BenchmarkMode)}
							disabled={isRunning}
						>
							{modeOptions.map((option) => (
								<option key={option} value={option}>
									{option}
								</option>
							))}
						</select>
					</label>

					<div className="flex items-end">
						<button
							type="button"
							className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
							onClick={() =>
								void runSingleBenchmark({
									nextMode: mode,
									nextPdf: pdf,
								})
							}
							disabled={isRunning}
						>
							{isRunning ? "Running…" : "Run benchmark"}
						</button>
					</div>
				</div>

				{lastMetric ? (
					<div className="grid gap-3 rounded-lg border bg-white p-4 md:grid-cols-4">
						<div>
							<div className="text-xs uppercase text-slate-500">Requested</div>
							<div className="text-lg font-semibold">
								{lastMetric.requestedMode}
							</div>
						</div>
						<div>
							<div className="text-xs uppercase text-slate-500">Actual</div>
							<div className="text-lg font-semibold">
								{lastMetric.actualMode}
							</div>
						</div>
						<div>
							<div className="text-xs uppercase text-slate-500">Text ready</div>
							<div className="text-lg font-semibold">
								{lastMetric.textLayerReadyMs?.toFixed(1) ?? "—"} ms
							</div>
						</div>
						<div>
							<div className="text-xs uppercase text-slate-500">p95 frame</div>
							<div className="text-lg font-semibold">
								{lastMetric.p95FrameMs?.toFixed(1) ?? "—"} ms
							</div>
						</div>
						<div>
							<div className="text-xs uppercase text-slate-500">p50 frame</div>
							<div className="text-lg font-semibold">
								{lastMetric.p50FrameMs?.toFixed(1) ?? "—"} ms
							</div>
						</div>
						<div>
							<div className="text-xs uppercase text-slate-500">
								Frames over 50ms
							</div>
							<div className="text-lg font-semibold">
								{lastMetric.framesOver50ms}
							</div>
						</div>
						<div>
							<div className="text-xs uppercase text-slate-500">
								Frames over 100ms
							</div>
							<div className="text-lg font-semibold">
								{lastMetric.framesOver100ms}
							</div>
						</div>
						<div>
							<div className="text-xs uppercase text-slate-500">Fallback</div>
							<div className="text-sm font-medium">
								{lastMetric.fallbackReason ?? "none"}
							</div>
						</div>
					</div>
				) : null}

				<BenchmarkViewer
					mode={mode}
					source={source}
					onTextLayerReady={(payload) => {
						readyPayloadRef.current = payload;
					}}
				/>
			</div>
		</div>
	);
}
