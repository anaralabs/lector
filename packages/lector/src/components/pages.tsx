import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
	type HTMLProps,
	type ReactElement,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";

import { useFitWidth } from "../hooks/pages/useFitWidth";
import { useObserveElement } from "../hooks/pages/useObserveElement";
import { useScrollFn } from "../hooks/pages/useScrollFn";
import { useVisiblePage } from "../hooks/pages/useVisiblePage";
import { useViewportContainer } from "../hooks/viewport/useViewportContainer";
import { usePdf } from "../internal";
import { Primitive } from "./primitive";

const selectLargestPageWidth = (state: {
	viewports: Array<{ width: number }>;
}) => state.viewports.reduce((max, vp) => Math.max(max, vp.width), 0);

const DEFAULT_HEIGHT = 600;
const EXTRA_HEIGHT = 0;
const DEFAULT_VIRTUALIZER_OPTIONS = { overscan: 1 };

export const Pages = ({
	children: _children,
	gap = 10,
	virtualizerOptions = DEFAULT_VIRTUALIZER_OPTIONS,
	initialOffset,
	onOffsetChange,
	...props
}: HTMLProps<HTMLDivElement> & {
	virtualizerOptions?: {
		overscan?: number;
	};
	gap?: number;
	children: ReactElement;
	initialOffset?: number;
	onOffsetChange?: (offset: number) => void;
}) => {
	const viewports = usePdf((state) => state.viewports);
	const numPages = usePdf((state) => state.pdfDocumentProxy.numPages);
	const pageProxies = usePdf((state) => state.pageProxies);
	const markPageRendered = usePdf((state) => state.markPageRendered);

	const elementWrapperRef = useRef<HTMLDivElement>(null);
	const elementRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const flatGridRef = useRef<HTMLDivElement>(null);

	useViewportContainer({
		elementRef: elementRef,
		elementWrapperRef: elementWrapperRef,
		containerRef,
	});

	const setVirtualizer = usePdf((state) => state.setVirtualizer);

	const { scrollToFn } = useScrollFn();
	const { observeElementOffset } = useObserveElement();

	const viewportsRef = useRef(viewports);
	viewportsRef.current = viewports;

	const estimateSize = useCallback(
		(index: number) => {
			const vp = viewportsRef.current;
			if (!vp || !vp[index]) return DEFAULT_HEIGHT;
			return vp[index].height + EXTRA_HEIGHT;
		},
		[],
	);

	const virtualizer = useVirtualizer({
		count: numPages || 0,
		getScrollElement: () => containerRef.current,
		estimateSize,
		observeElementOffset,
		overscan: virtualizerOptions?.overscan ?? 0,
		scrollToFn,
		gap,
		initialOffset: initialOffset,
	});

	useEffect(() => {
		if (onOffsetChange && virtualizer.scrollOffset)
			onOffsetChange(virtualizer.scrollOffset);
	}, [virtualizer.scrollOffset, onOffsetChange]);

	useEffect(() => {
		setVirtualizer(virtualizer);
	}, [setVirtualizer, virtualizer]);

	// Build a stable, full-list-of-pages "virtual items" array. This is computed
	// once per (numPages, viewports, gap) and never updates on scroll — so any
	// hook that consumes it (useVisiblePage) won't churn on scroll either.
	const fullItems = useMemo<VirtualItem[]>(() => {
		const items: VirtualItem[] = [];
		let offset = 0;
		for (let i = 0; i < (numPages || 0); i++) {
			const h = viewports?.[i]?.height ?? DEFAULT_HEIGHT;
			items.push({
				key: i,
				index: i,
				start: offset,
				end: offset + h,
				size: h,
				lane: 0,
			});
			offset += h + gap;
		}
		return items;
	}, [numPages, viewports, gap]);

	useVisiblePage({ items: fullItems });

	useFitWidth({ viewportRef: containerRef });
	const largestPageWidth = usePdf(selectLargestPageWidth);

	useEffect(() => {
		virtualizer.getOffsetForAlignment = (
			toOffset: number,
			align: "start" | "center" | "end" | "auto",
			itemSize = 0,
		) => {
			//@ts-expect-error this is a private stuff
			const size = virtualizer.getSize();

			//@ts-expect-error this is a private stuff
			const scrollOffset = virtualizer.getScrollOffset();

			if (align === "auto") {
				align = toOffset >= scrollOffset + size ? "end" : "start";
			}

			if (align === "center") {
				toOffset += (itemSize - size) / 2;
			} else if (align === "end") {
				toOffset -= size;
			}

			return Math.max(toOffset, 0);
		};
	}, [virtualizer]);

	// ── Wild path: imperative flat-DOM canvas grid ──────────────────────────────
	// One mount-once effect that paints every page exactly once when numPages
	// and pageProxies are known. Scroll is native browser scroll over absolute-
	// positioned canvases — zero React commits below <Pages> per tick.
	useEffect(() => {
		const grid = flatGridRef.current;
		if (!grid) return;
		if (!numPages || pageProxies.length === 0) return;

		grid.innerHTML = "";

		const canvases: HTMLCanvasElement[] = [];
		const cancellers: Array<() => void> = [];
		const dpr =
			typeof window !== "undefined" && window.devicePixelRatio
				? window.devicePixelRatio
				: 1;

		let offsetY = 0;
		for (let i = 0; i < numPages; i++) {
			const proxy = pageProxies[i];
			if (!proxy) continue;
			const baseViewport = proxy.getViewport({ scale: 1 });
			const w = baseViewport.width;
			const h = baseViewport.height;

			const pageWrap = document.createElement("div");
			pageWrap.style.position = "absolute";
			pageWrap.style.left = "50%";
			pageWrap.style.transform = `translateX(-50%) translateY(${offsetY}px)`;
			pageWrap.style.width = `${w}px`;
			pageWrap.style.height = `${h}px`;
			pageWrap.style.backgroundColor = "white";
			pageWrap.dataset.pageNumber = String(i + 1);

			const canvas = document.createElement("canvas");
			canvas.style.position = "absolute";
			canvas.style.top = "0";
			canvas.style.left = "0";
			canvas.style.width = `${w}px`;
			canvas.style.height = `${h}px`;
			canvas.width = Math.floor(w * dpr);
			canvas.height = Math.floor(h * dpr);

			pageWrap.appendChild(canvas);
			grid.appendChild(pageWrap);
			canvases.push(canvas);

			const ctx = canvas.getContext("2d");
			if (ctx) {
				const scaledVp = proxy.getViewport({ scale: dpr });
				const task = proxy.render({
					canvas: canvas as never,
					canvasContext: ctx as never,
					viewport: scaledVp,
				} as never);
				cancellers.push(() => {
					try {
						(task as { cancel: () => void }).cancel();
					} catch {
						// ignore
					}
				});
				task.promise
					.then(() => {
						markPageRendered(i + 1);
					})
					.catch(() => {
						// ignore (cancellation or worker errors)
					});
			}

			offsetY += h + gap;
		}

		// Size the inner element so the existing zoom/pinch transform math
		// (which reads elementRef.style.width/height) keeps working.
		const grid_h = offsetY > 0 ? offsetY - gap : 0;
		if (elementRef.current) {
			elementRef.current.style.height = `${grid_h}px`;
		}

		return () => {
			for (const c of cancellers) c();
			for (const c of canvases) {
				c.width = 0;
				c.height = 0;
			}
			grid.innerHTML = "";
		};
		// Intentionally mount-once when numPages + pageProxies are known.
		// We do NOT re-run on viewports/gap changes — scroll must not trigger this.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [numPages, pageProxies]);

	const totalSize = virtualizer.getTotalSize();

	return (
		<Primitive.div
			ref={containerRef}
			{...props}
			style={{
				display: "flex",
				justifyContent: "center",
				height: "100%",
				position: "relative",
				overflow: "auto",
				...props.style,
			}}
		>
			<div
				ref={elementWrapperRef}
				style={{
					width: "max-content",
				}}
			>
				<div
					ref={elementRef}
					style={{
						height: `${totalSize}px`,
						position: "absolute",
						display: "block",
						transformOrigin: "0 0",
						willChange: "transform",
						width: largestPageWidth,
						margin: "0 auto",
					}}
				>
					<div
						ref={flatGridRef}
						style={{
							position: "relative",
							width: "100%",
							height: "100%",
						}}
					/>
				</div>
			</div>
		</Primitive.div>
	);
};
