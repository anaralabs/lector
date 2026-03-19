import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
	cloneElement,
	type HTMLProps,
	type ReactElement,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import { useFitWidth } from "../hooks/pages/useFitWidth";
import { useObserveElement } from "../hooks/pages/useObserveElement";
import { useScrollFn } from "../hooks/pages/useScrollFn";
import { useVisiblePage } from "../hooks/pages/useVisiblePage";
import { useViewportContainer } from "../hooks/viewport/useViewportContainer";
import { usePdf } from "../internal";
import { cancelPrerender, prerenderPages } from "../lib/prerenderer";
import { Primitive } from "./primitive";

const DEFAULT_HEIGHT = 600;
const EXTRA_HEIGHT = 0;

export const Pages = ({
	children,
	gap = 10,
	virtualizerOptions = { overscan: 2 },
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
	const [tempItems, setTempItems] = useState<VirtualItem[]>([]);

	const viewports = usePdf((state) => state.viewports);
	const numPages = usePdf((state) => state.pdfDocumentProxy.numPages);
	const isPinching = usePdf((state) => state.isPinching);

	const elementWrapperRef = useRef<HTMLDivElement>(null);
	const elementRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	useViewportContainer({
		elementRef: elementRef,
		elementWrapperRef: elementWrapperRef,
		containerRef,
	});

	const setVirtualizer = usePdf((state) => state.setVirtualizer);
	const setIsScrolling = usePdf((state) => state.setIsScrolling);

	const { scrollToFn } = useScrollFn();
	const { observeElementOffset } = useObserveElement();

	const estimateSize = useCallback(
		(index: number) => {
			if (!viewports || !viewports[index]) return DEFAULT_HEIGHT;
			return viewports[index].height + EXTRA_HEIGHT;
		},
		[viewports],
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
		onChange: (instance) => {
			setIsScrolling(instance.isScrolling);
		},
	});

	useEffect(() => {
		if (onOffsetChange && virtualizer.scrollOffset)
			onOffsetChange(virtualizer.scrollOffset);
	}, [virtualizer.scrollOffset, onOffsetChange]);

	useEffect(() => {
		setVirtualizer(virtualizer);
	}, [setVirtualizer, virtualizer]);

	useEffect(() => {
		if (!virtualizer) return;

		let timeout: NodeJS.Timeout;
		const virtualized = virtualizer.getVirtualItems();

		if (!isPinching) {
			virtualizer.measure();

			timeout = setTimeout(() => {
				setTempItems([]);
			}, 200);
		} else if (virtualized && virtualized.length > 0) {
			setTempItems(virtualized);
		}

		return () => {
			clearTimeout(timeout);
		};
	}, [isPinching, virtualizer]);

	const virtualizerItems = virtualizer?.getVirtualItems() ?? [];
	const items = tempItems.length ? tempItems : virtualizerItems;

	// const { normalizedVelocity } = useVirtualizerVelocity({
	//   virtualizer,
	// });

	// const isScrollingFast = Math.abs(normalizedVelocity) > 1.5;
	// const shouldRender = !isScrollingFast;

	useVisiblePage({
		items,
	});

	const isScrolling = usePdf((state) => state.isScrolling);
	const zoom = usePdf((state) => state.zoom);
	const pageProxies = usePdf((state) => state.pageProxies);

	useEffect(() => {
		if (isScrolling || isPinching) {
			cancelPrerender();
			return;
		}

		if (items.length === 0 || typeof OffscreenCanvas === "undefined") return;

		const visibleIndices = items.map((i) => i.index);
		const minIdx = Math.min(...visibleIndices);
		const maxIdx = Math.max(...visibleIndices);

		const adjacentPages: number[] = [];
		for (let i = maxIdx + 1; i <= Math.min(maxIdx + 3, numPages - 1); i++) {
			adjacentPages.push(i);
		}
		for (let i = minIdx - 1; i >= Math.max(minIdx - 2, 0); i--) {
			adjacentPages.push(i);
		}

		const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
		const scale = dpr * Math.min(zoom, 1);
		const jobs = adjacentPages
			.map((idx) => {
				const proxy = pageProxies[idx];
				if (!proxy) return null;
				return { pageNumber: idx + 1, scale, pageProxy: proxy };
			})
			.filter(Boolean) as {
			pageNumber: number;
			scale: number;
			pageProxy: (typeof pageProxies)[number];
		}[];

		if (jobs.length > 0) {
			prerenderPages(jobs);
		}

		return () => {
			cancelPrerender();
		};
	}, [isScrolling, isPinching, items, numPages, zoom, pageProxies]);

	useFitWidth({ viewportRef: containerRef });
	const largestPageWidth = usePdf((state) =>
		Math.max(...state.viewports.map((v) => v.width)),
	);

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
				// When aligning to a particular item (e.g. with scrollToIndex),
				// adjust offset by the size of the item to center on the item
				toOffset += (itemSize - size) / 2;
			} else if (align === "end") {
				toOffset -= size;
			}

			const scrollSizeProp = virtualizer.options.horizontal
				? "scrollWidth"
				: "scrollHeight";
			const scrollSize = virtualizer.scrollElement
				? "document" in virtualizer.scrollElement
					? //@ts-expect-error this is a private stuff
						virtualizer.scrollElement.document.documentElement[scrollSizeProp]
					: virtualizer.scrollElement[scrollSizeProp]
				: 0;

			const _maxOffset = scrollSize - size;

			return Math.max(toOffset, 0);
		};
	}, [virtualizer]);

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
						height: `${virtualizer.getTotalSize()}px`,
						position: "absolute",
						display: "flex",
						alignItems: "center",
						flexDirection: "column",
						transformOrigin: "0 0",
						// width: "max-content",
						width: largestPageWidth,
						margin: "0 auto",
					}}
				>
					{items.map((virtualItem) => {
						const innerBoxWidth = viewports?.[virtualItem.index]
							? viewports[virtualItem.index]?.width
							: 0;

						if (!innerBoxWidth) return null;

						return (
							<div
								key={virtualItem.key}
								style={{
									width: innerBoxWidth,
									height: `0px`,
								}}
							>
								<div
									style={{
										height: `${virtualItem.size}px`,
										transform: `translateY(${virtualItem.start}px)`,
									}}
								>
									{cloneElement(children, {
										key: virtualItem.key,
										//@ts-expect-error pageNumber is not a valid react key
										pageNumber: virtualItem.index + 1,
									})}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</Primitive.div>
	);
};
