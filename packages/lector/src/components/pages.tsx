import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
	cloneElement,
	type HTMLProps,
	memo,
	type ReactElement,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { useFitWidth } from "../hooks/pages/useFitWidth";
import { useObserveElement } from "../hooks/pages/useObserveElement";
import { useScrollFn } from "../hooks/pages/useScrollFn";
import { useVisiblePage } from "../hooks/pages/useVisiblePage";
import { useViewportContainer } from "../hooks/viewport/useViewportContainer";
import { usePdf } from "../internal";
import { registerPdfCopy } from "../lib/selection-text";
import type { SelectionTextOptions } from "../lib/text-normalization";
import { USE_LAYOUT_ZOOM } from "../lib/zoom";
import { Primitive } from "./primitive";

const DEFAULT_HEIGHT = 600;
const EXTRA_HEIGHT = 0;
const DEFAULT_VIRTUALIZER_OPTIONS = { overscan: 1 };

interface VirtualizedPageItemProps {
	child: ReactElement;
	virtualItem: VirtualItem;
	innerBoxWidth: number;
}

const VirtualizedPageItem = memo(
	({ child, virtualItem, innerBoxWidth }: VirtualizedPageItemProps) => {
		return (
			<div
				style={{
					width: innerBoxWidth,
					height: "0px",
				}}
			>
				<div
					style={{
						height: `${virtualItem.size}px`,
						transform: `translateY(${virtualItem.start}px)`,
					}}
				>
					{cloneElement(child, {
						key: virtualItem.key,
						//@ts-expect-error pageNumber is not a valid react key
						pageNumber: virtualItem.index + 1,
					})}
				</div>
			</div>
		);
	},
	(prev, next) =>
		prev.child === next.child &&
		prev.innerBoxWidth === next.innerBoxWidth &&
		prev.virtualItem.key === next.virtualItem.key &&
		prev.virtualItem.index === next.virtualItem.index &&
		prev.virtualItem.size === next.virtualItem.size &&
		prev.virtualItem.start === next.virtualItem.start,
);

VirtualizedPageItem.displayName = "VirtualizedPageItem";

export const Pages = ({
	children,
	gap = 10,
	virtualizerOptions = DEFAULT_VIRTUALIZER_OPTIONS,
	initialOffset,
	onOffsetChange,
	copyOptions,
	...props
}: HTMLProps<HTMLDivElement> & {
	virtualizerOptions?: {
		overscan?: number;
	};
	gap?: number;
	children: ReactElement;
	initialOffset?: number;
	onOffsetChange?: (offset: number) => void;
	/** Plain-text PDF copying. Preserve line breaks by default; false uses native copying. */
	copyOptions?: false | SelectionTextOptions;
}) => {
	const [tempItems, setTempItems] = useState<VirtualItem[]>([]);

	const viewports = usePdf((state) => state.viewports);
	const numPages = usePdf((state) => state.pdfDocumentProxy.numPages);
	const initialPage = usePdf((state) => state.initialPage);
	const isPinching = usePdf((state) => state.isPinching);

	const elementWrapperRef = useRef<HTMLDivElement>(null);
	const elementRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const copyOptionsRef = useRef(copyOptions);
	copyOptionsRef.current = copyOptions;
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		return registerPdfCopy(container, () => copyOptionsRef.current ?? {});
	}, []);

	useViewportContainer({
		elementRef: elementRef,
		elementWrapperRef: elementWrapperRef,
		containerRef,
	});

	const setVirtualizer = usePdf((state) => state.setVirtualizer);

	const { scrollToFn } = useScrollFn();
	const { observeElementOffset, observeElementRect } = useObserveElement();

	const viewportsRef = useRef(viewports);
	viewportsRef.current = viewports;

	const estimateSize = useCallback(
		(index: number) => {
			const vp = viewportsRef.current;
			if (!vp || !vp[index]) return DEFAULT_HEIGHT;
			return vp[index].height + EXTRA_HEIGHT;
		},
		[], // Stable — reads from ref
	);

	const [startingOffset] = useState(
		() =>
			initialOffset ??
			viewports
				.slice(0, initialPage - 1)
				.reduce(
					(offset, viewport) => offset + viewport.height + EXTRA_HEIGHT + gap,
					0,
				),
	);

	const virtualizer = useVirtualizer({
		count: numPages || 0,
		getScrollElement: () => containerRef.current,
		estimateSize,
		observeElementOffset,
		observeElementRect,
		overscan: virtualizerOptions?.overscan ?? 0,
		scrollToFn,
		gap,
		initialOffset: startingOffset,
		// Never trust scrollend alone to reset isScrolling: a single missed
		// event (a documented browser flake — TanStack flipped this default to
		// false in later 3.x) would pin isScrolling=true forever, and every
		// consumer gated on it (text layer, detail canvas) would stop painting.
		// false keeps the isScrollingResetDelay debounce active as a fallback.
		useScrollendEvent: false,
	});

	const previousViewports = useRef(viewports);
	useLayoutEffect(() => {
		// Gesture rendering freezes virtual positions; apply accumulated corrections
		// after the gesture commits rather than moving its original content anchor.
		if (isPinching) return;
		const previous = previousViewports.current;
		previousViewports.current = viewports;
		if (previous === viewports) return;
		// resizeItem corrects offsets above the visible page, preserving the reading anchor
		// when estimated dimensions resolve (including intrinsic page rotation).
		let resized = false;
		for (let index = 0; index < viewports.length; index++) {
			if (previous[index]?.height !== viewports[index]?.height) {
				virtualizer.resizeItem(index, viewports[index]!.height + EXTRA_HEIGHT);
				resized = true;
			}
		}
		// Retiring the gesture snapshot and correcting its scroll offset must
		// paint together, rather than showing old positions for another 200 ms.
		if (resized) setTempItems([]);
	}, [viewports, virtualizer, isPinching]);

	useEffect(() => {
		if (onOffsetChange && virtualizer.scrollOffset)
			onOffsetChange(virtualizer.scrollOffset);
	}, [virtualizer.scrollOffset, onOffsetChange]);

	useEffect(() => {
		setVirtualizer(virtualizer);
	}, [setVirtualizer, virtualizer]);

	useEffect(() => {
		let timeout: NodeJS.Timeout;
		const virtualized = virtualizer?.getVirtualItems();

		if (!isPinching) {
			virtualizer?.measure();

			timeout = setTimeout(() => {
				setTempItems([]);
			}, 200);
		} else if (virtualized && virtualized?.length > 0) {
			setTempItems(virtualized);
		}

		return () => {
			clearTimeout(timeout);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isPinching, virtualizer?.measure, virtualizer?.getVirtualItems]);

	const virtualizerItems = virtualizer?.getVirtualItems() ?? [];
	const items = tempItems.length ? tempItems : virtualizerItems;

	useVisiblePage({
		items,
		// Pass through nullish (pre-measure) rather than coercing to 0, so the
		// hook doesn't publish a top-of-document page before the real offset
		// (incl. a restored/deep-linked one) arrives.
		scrollOffset: virtualizer.scrollOffset ?? null,
	});

	useFitWidth({ viewportRef: containerRef });
	const largestPageWidth = useMemo(
		() => viewports.reduce((max, viewport) => Math.max(max, viewport.width), 0),
		[viewports],
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
				height: "100%",
				position: "relative",
				overflow: "auto",
				...props.style,
			}}
		>
			<div
				ref={elementWrapperRef}
				style={{
					// The absolute page list contributes no intrinsic width. Reserve
					// its width before any zoom effect runs (including zoom === 1).
					width: largestPageWidth,
					marginLeft: "auto",
					marginRight: "auto",
					flexShrink: 0,
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
						willChange: USE_LAYOUT_ZOOM ? "auto" : "transform",
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
							<VirtualizedPageItem
								key={virtualItem.key}
								child={children}
								virtualItem={virtualItem}
								innerBoxWidth={innerBoxWidth}
							/>
						);
					})}
				</div>
			</div>
		</Primitive.div>
	);
};
