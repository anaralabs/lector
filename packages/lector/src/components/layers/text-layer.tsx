import clsx from "clsx";
import { type HTMLProps, memo } from "react";

import { useTextLayer } from "../../hooks/layers/useTextLayer";

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
