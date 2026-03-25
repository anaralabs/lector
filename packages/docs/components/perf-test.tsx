"use client";

import {
	CanvasLayer,
	Page,
	Pages,
	Root,
	TextLayer,
	usePdf,
} from "@anaralabs/lector";
import "@/lib/setup";
import { useCallback, useEffect, useRef, useState } from "react";

const PDFS = [
	{ name: "Heavy (arxiv scatter plots)", url: "/pdf/2506.13188v1.pdf" },
	{ name: "Expensive", url: "/pdf/expensive.pdf" },
	{ name: "Large", url: "/pdf/large.pdf" },
	{ name: "Pathways", url: "/pdf/pathways.pdf" },
];

function FpsCounter() {
	const fpsRef = useRef<HTMLSpanElement>(null);
	const longRef = useRef<HTMLSpanElement>(null);
	const jankRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let frames = 0;
		let lastTime = performance.now();
		let longCount = 0;
		let prevFrame = performance.now();
		let rafId: number;

		const loop = () => {
			frames++;
			const now = performance.now();
			const delta = now - prevFrame;
			prevFrame = now;

			if (delta > 50 && frames > 2) {
				longCount++;
				if (longRef.current) longRef.current.textContent = String(longCount);
				if (jankRef.current) {
					jankRef.current.style.backgroundColor = "#ef4444";
					setTimeout(() => {
						if (jankRef.current)
							jankRef.current.style.backgroundColor = "#22c55e";
					}, 300);
				}
			}

			if (now - lastTime >= 1000) {
				const fps = Math.round((frames * 1000) / (now - lastTime));
				if (fpsRef.current) {
					fpsRef.current.textContent = String(fps);
					fpsRef.current.style.color =
						fps < 30 ? "#ef4444" : fps < 50 ? "#eab308" : "#22c55e";
				}
				frames = 0;
				lastTime = now;
			}

			rafId = requestAnimationFrame(loop);
		};

		rafId = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(rafId);
	}, []);

	return (
		<div className="flex items-center gap-4 font-mono text-xs">
			<div className="flex items-center gap-1.5">
				<span className="text-muted-foreground">FPS</span>
				<span ref={fpsRef} className="font-bold tabular-nums">
					--
				</span>
			</div>
			<div className="flex items-center gap-1.5">
				<span className="text-muted-foreground">Jank</span>
				<span ref={longRef} className="font-bold tabular-nums">
					0
				</span>
			</div>
			<div
				ref={jankRef}
				className="w-2.5 h-2.5 rounded-full bg-green-500 transition-colors"
			/>
		</div>
	);
}

function ScrollBenchmark() {
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const virtualizer = usePdf((s) => s.virtualizer);
	const viewportRef = usePdf((s) => s.viewportRef);

	const run = useCallback(() => {
		const el = viewportRef?.current;
		if (!el || !virtualizer) return;

		setRunning(true);
		setResult(null);

		const longFrames: number[] = [];
		let frames = 0;
		let lastFrame = performance.now();
		let rafId: number;

		const measure = () => {
			const now = performance.now();
			const dt = now - lastFrame;
			if (dt > 50 && frames > 1) longFrames.push(dt);
			frames++;
			lastFrame = now;
			rafId = requestAnimationFrame(measure);
		};

		rafId = requestAnimationFrame(measure);

		const total = el.scrollHeight - el.clientHeight;
		const duration = 3000;
		const t0 = performance.now();
		const s0 = el.scrollTop;

		const scroll = () => {
			const p = Math.min((performance.now() - t0) / duration, 1);
			const ease =
				p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
			el.scrollTop = s0 + total * ease;

			if (p < 1) {
				requestAnimationFrame(scroll);
			} else {
				cancelAnimationFrame(rafId);
				const avgFps = Math.round(1000 / (duration / frames));
				const worst = longFrames.length
					? Math.round(Math.max(...longFrames))
					: 0;
				setResult(
					`${frames} frames | ${avgFps} avg FPS | ${longFrames.length} jank (>50ms) | worst ${worst}ms`,
				);
				setRunning(false);
			}
		};

		requestAnimationFrame(scroll);
	}, [virtualizer, viewportRef]);

	return (
		<div className="flex items-center gap-3">
			<button
				type="button"
				onClick={run}
				disabled={running}
				className="px-3 py-1 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
			>
				{running ? "Running..." : "Scroll Test"}
			</button>
			{result && (
				<span className="text-xs font-mono text-muted-foreground">
					{result}
				</span>
			)}
		</div>
	);
}

function PageInfo() {
	const page = usePdf((s) => s.currentPage);
	const total = usePdf((s) => s.pdfDocumentProxy.numPages);

	return (
		<span className="text-xs text-muted-foreground tabular-nums">
			Page {page}/{total} | DPR{" "}
			{typeof window !== "undefined" ? window.devicePixelRatio : 1}
		</span>
	);
}

function Toolbar() {
	return (
		<div className="flex items-center justify-between px-3 py-2 border-b">
			<PageInfo />
			<div className="flex items-center gap-4">
				<FpsCounter />
				<ScrollBenchmark />
			</div>
		</div>
	);
}

const UNOPTIMIZED = {
	enableHWA: false,
	canvasMaxAreaInBytes: -1,
	isOffscreenCanvasSupported: false,
};

export default function PerfTest() {
	const [selectedPdf, setSelectedPdf] = useState(PDFS[0].url);
	const [optimized, setOptimized] = useState(true);

	return (
		<div className="flex flex-col gap-4 w-full max-w-4xl mx-auto">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">Perf Test</h1>
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={() => setOptimized(!optimized)}
						className={`px-3 py-1 text-xs font-medium rounded-md border ${
							optimized
								? "bg-green-600 text-white border-green-600"
								: "bg-red-600 text-white border-red-600"
						}`}
					>
						{optimized ? "Optimized" : "Baseline (old)"}
					</button>
					<select
						value={selectedPdf}
						onChange={(e) => setSelectedPdf(e.target.value)}
						className="text-sm border rounded-md px-2 py-1 bg-background"
					>
						{PDFS.map((pdf) => (
							<option key={pdf.url} value={pdf.url}>
								{pdf.name}
							</option>
						))}
					</select>
				</div>
			</div>

			<div className="border rounded-lg overflow-hidden h-[750px] flex flex-col bg-neutral-100 dark:bg-neutral-900">
				<Root
					key={`${selectedPdf}-${optimized}`}
					source={selectedPdf}
					documentOptions={optimized ? undefined : UNOPTIMIZED}
					className="flex flex-col flex-1 min-h-0"
					loader={
						<div className="flex-1 flex items-center justify-center text-muted-foreground">
							Loading PDF...
						</div>
					}
				>
					<Toolbar />
					<Pages>
						<Page>
							<CanvasLayer />
							<TextLayer />
						</Page>
					</Pages>
				</Root>
			</div>
		</div>
	);
}
