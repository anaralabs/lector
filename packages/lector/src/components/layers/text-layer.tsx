import clsx from "clsx";
import { type HTMLProps, memo } from "react";

import { useTextLayer } from "../../hooks/layers/useTextLayer";
import { LAYOUT_ZOOM_PROPERTY } from "../../lib/viewport-zoom";
import { USE_LAYOUT_ZOOM } from "../../lib/zoom";

// Under WebKit layout zoom, Safari sizes this text wrongly: iOS doesn't zoom
// text with `text-size-adjust: none` (set on .textLayer by pdf_viewer.css) at
// all, and macOS won't shrink zoomed text below its 9px minimum font size.
// Either way the spans stop matching the glyphs on the canvas. Undo the zoom
// for this subtree and scale it instead, which Safari applies to text as is.
// Before the first settled zoom is published these resolve to `zoom: 1` and
// `scale: none`. Other browsers zoom with a transform and get none of this.
const COUNTER_LAYOUT_ZOOM = USE_LAYOUT_ZOOM
	? {
			zoom: `calc(1 / var(${LAYOUT_ZOOM_PROPERTY}, 1))`,
			scale: `var(${LAYOUT_ZOOM_PROPERTY}, none)`,
			transformOrigin: "0 0",
		}
	: undefined;

export const TextLayer = memo(
	({ className, style, ...props }: HTMLProps<HTMLDivElement>) => {
		const { textContainerRef, pageNumber } = useTextLayer();

		return (
			<div
				className={clsx("textLayer", className)}
				style={{
					...style,
					position: "absolute",
					top: 0,
					left: 0,
					// Isolate the span subtree's layout so a getBoundingClientRect on
					// an ancestor (e.g. renderDetailCanvas) doesn't reflow every text
					// span on this page during scroll.
					contain: "layout style",
					...COUNTER_LAYOUT_ZOOM,
				}}
				{...props}
				{...{
					"data-page-number": pageNumber,
				}}
				ref={textContainerRef}
			/>
		);
	},
);

TextLayer.displayName = "TextLayer";
