import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
	cloneElement,
	type HTMLProps,
	memo,
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
import { Primitive } from "./primitive";

const selectLargestPageWidth = (state: {
	viewports: Array<{ width: number }>;
}) => state.viewports.reduce((max, vp) => Math.max(max, vp.width), 0);

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

	const { scrollToFn } = useScrollFn();
	const { observeElementOffset, controller: scrollController } =
		useObserveElement();

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

	// Route offset updates through the scroll rAF instead of a render-path
	// effect. This avoids forcing a React commit for every scroll frame just
	// to notify the consumer — a big source of scroll jank at zoom=1.
	useEffect(() => {
		if (!onOffsetChange) return;
		return scrollController.addOffsetListener(onOffsetChange);
	}, [onOffsetChange, scrollController]);

	useEffect(() => {
		setVirtualizer(virtualizer);
	}, [setVirtualizer, virtualizer]);

	useEffect(() => {
		let timeout: NodeJS.Timeout;
		let rafId: number | null = null;
		const virtualized = virtualizer?.getVirtualItems();

		if (!isPinching) {
			// Defer the expensive `measure()` to the next animation frame so
			// the frame that handles pinch-end doesn't also get stuck doing
			// a full virtualizer remeasure. Users feel this as the "settling"
			// stutter after a zoom gesture.
			rafId = requestAnimationFrame(() => {
				rafId = null;
				virtualizer?.measure();
			});

			timeout = setTimeout(() => {
				setTempItems([]);
			}, 200);
		} else if (virtualized && virtualized?.length > 0) {
			setTempItems(virtualized);
		}

		return () => {
			clearTimeout(timeout);
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isPinching, virtualizer?.measure, virtualizer?.getVirtualItems]);

	const virtualizerItems = virtualizer?.getVirtualItems() ?? [];
	const items = tempItems.length ? tempItems : virtualizerItems;

	useVisiblePage({
		items,
	});

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
						// Only ask the compositor to keep this (huge) element on its
						// own layer while the user is actively pinching. Outside of
						// pinch, per-page `translateZ(0)` gives us per-page layers
						// which are cheaper to composite on scroll.
						willChange: isPinching ? "transform" : "auto",
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
