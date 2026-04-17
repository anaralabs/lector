import clsx from "clsx";
import { type CSSProperties, type HTMLProps, memo } from "react";

import { useTextLayer } from "../../hooks/layers/useTextLayer";

// `contain: strict` isolates the text layer's layout, style, paint and size
// from the rest of the page. Combined with the per-page `content-visibility`,
// this stops the browser from repainting hundreds of absolutely-positioned
// text spans across all mounted pages on every scroll frame.
const TEXT_LAYER_STYLE: CSSProperties = {
	position: "absolute",
	top: 0,
	left: 0,
	contain: "strict",
};

export const TextLayer = memo(
	({ className, style, ...props }: HTMLProps<HTMLDivElement>) => {
		const { textContainerRef, pageNumber } = useTextLayer();

		return (
			<div
				className={clsx("textLayer", className)}
				style={{
					...TEXT_LAYER_STYLE,
					...style,
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
