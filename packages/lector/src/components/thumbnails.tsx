import { useVirtualizer } from "@tanstack/react-virtual";
import {
	cloneElement,
	type FocusEvent,
	type HTMLProps,
	type KeyboardEvent,
	type MouseEvent,
	type ReactElement,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import { usePdfJump } from "../hooks/pages/usePdfJump";
import { useThumbnail } from "../hooks/useThumbnail";
import { usePdf } from "../internal";
import { Primitive } from "./primitive";

export const Thumbnail = ({
	pageNumber = 1,
	eager = false,
	...props
}: HTMLProps<HTMLCanvasElement> & { pageNumber?: number; eager?: boolean }) => {
	const { canvasRef, containerRef, isVisible } = useThumbnail(pageNumber, {
		isFirstPage: eager || pageNumber < 5,
	});
	const { jumpToPage } = usePdfJump();
	const isCurrentPage = usePdf((state) => state.currentPage === pageNumber);
	const spacePressed = useRef(false);

	return (
		<div ref={containerRef} style={{ minHeight: "150px", minWidth: "10px" }}>
			{isVisible && (
				<Primitive.canvas
					aria-label={`Page ${pageNumber}`}
					aria-current={isCurrentPage ? "page" : undefined}
					{...props}
					role="button"
					tabIndex={0}
					onClick={(event: MouseEvent<HTMLCanvasElement>) => {
						props.onClick?.(event);
						if (!event.defaultPrevented)
							jumpToPage(pageNumber, { behavior: "auto" });
					}}
					onKeyDown={(event: KeyboardEvent<HTMLCanvasElement>) => {
						props.onKeyDown?.(event);
						if (event.defaultPrevented) return;
						if (event.key === "Enter") {
							event.preventDefault();
							jumpToPage(pageNumber, { behavior: "auto" });
						} else if (event.key === " ") {
							// Match a button: prevent scrolling on press, activate on release.
							event.preventDefault();
							spacePressed.current = true;
						}
					}}
					onKeyUp={(event: KeyboardEvent<HTMLCanvasElement>) => {
						props.onKeyUp?.(event);
						if (event.key !== " ") return;
						const activate = spacePressed.current && !event.defaultPrevented;
						spacePressed.current = false;
						if (activate) {
							event.preventDefault();
							jumpToPage(pageNumber, { behavior: "auto" });
						}
					}}
					onBlur={(event: FocusEvent<HTMLCanvasElement>) => {
						spacePressed.current = false;
						props.onBlur?.(event);
					}}
					ref={canvasRef}
				/>
			)}
		</div>
	);
};

interface ThumbnailVirtualization {
	/** Fixed row height in CSS pixels, including any desired space between items. */
	itemHeight: number;
	overscan?: number;
}
type ThumbnailsProps = HTMLProps<HTMLDivElement> & {
	children: ReactElement;
	/** Opt in to a bounded list. Give the container a height and each row content that fits itemHeight. */
	virtualize?: ThumbnailVirtualization;
};

function VirtualizedThumbnails({
	children,
	count,
	virtualize,
	style,
	onKeyDown,
	ref,
	...props
}: ThumbnailsProps & { count: number; virtualize: ThumbnailVirtualization }) {
	const containerRef = useRef<HTMLDivElement>(null);
	useImperativeHandle(ref, () => containerRef.current!);
	const [focusPage, setFocusPage] = useState<number | null>(null);
	const itemHeight = Number.isFinite(virtualize.itemHeight)
		? Math.max(1, virtualize.itemHeight)
		: 150;
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => containerRef.current,
		estimateSize: () => itemHeight,
		overscan: virtualize.overscan ?? 2,
	});
	const items = virtualizer.getVirtualItems();
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry focus after the requested virtual row mounts
	useLayoutEffect(() => {
		if (focusPage === null) return;
		const canvas = containerRef.current?.querySelector<HTMLCanvasElement>(
			`[data-thumbnail-page="${focusPage}"] canvas`,
		);
		if (canvas) {
			canvas.focus({ preventScroll: true });
			setFocusPage(null);
		}
	}, [focusPage, items]);
	return (
		<Primitive.div
			{...props}
			ref={containerRef}
			style={{
				height: "100%",
				overflow: "auto",
				position: "relative",
				...style,
			}}
			onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
				onKeyDown?.(event);
				if (event.defaultPrevented || !count) return;
				const row = (event.target as HTMLElement).closest<HTMLElement>(
					"[data-thumbnail-page]",
				);
				if (!row) return;
				const current = Number(row.dataset.thumbnailPage) - 1;
				const next =
					event.key === "Home"
						? 0
						: event.key === "End"
							? count - 1
							: event.key === "ArrowDown"
								? Math.min(count - 1, current + 1)
								: event.key === "ArrowUp"
									? Math.max(0, current - 1)
									: null;
				if (next === null) return;
				event.preventDefault();
				virtualizer.scrollToIndex(next, { align: "auto" });
				setFocusPage(next + 1);
			}}
		>
			<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
				{items.map((item) => (
					<div
						key={item.key}
						data-thumbnail-page={item.index + 1}
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							height: itemHeight,
							transform: `translateY(${item.start}px)`,
						}}
					>
						{cloneElement(
							children as ReactElement<{ pageNumber: number; eager: boolean }>,
							{ pageNumber: item.index + 1, eager: true },
						)}
					</div>
				))}
			</div>
		</Primitive.div>
	);
}

export const Thumbnails = ({
	children,
	virtualize,
	...props
}: ThumbnailsProps) => {
	const pageCount = usePdf((state) => state.pdfDocumentProxy.numPages);
	if (virtualize)
		return (
			<VirtualizedThumbnails
				{...props}
				virtualize={virtualize}
				count={pageCount}
			>
				{children}
			</VirtualizedThumbnails>
		);
	return (
		<Primitive.div {...props}>
			{Array.from({ length: pageCount }, (_, index) =>
				cloneElement(children as ReactElement<{ pageNumber: number }>, {
					// biome-ignore lint/suspicious/noArrayIndexKey: a PDF page has a stable ordinal within this document
					key: index,
					pageNumber: index + 1,
				}),
			)}
		</Primitive.div>
	);
};
