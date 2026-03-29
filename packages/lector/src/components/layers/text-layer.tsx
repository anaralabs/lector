import clsx from "clsx";
import { type HTMLProps, memo } from "react";

import { useTextLayer } from "../../hooks/layers/useTextLayer";

export const TextLayer = memo(
	({
		className,
		style,
		mode = "auto",
		...props
	}: HTMLProps<HTMLDivElement> & {
		mode?: "auto" | "pretext" | "pdfjs";
	}) => {
		const {
			textContainerRef,
			pageNumber,
			renderMode,
			fallbackReason,
			requestedMode,
		} = useTextLayer({
			mode,
		});

		return (
			<div
				className={clsx("textLayer", className)}
				style={{
					...style,
					position: "absolute",
					top: 0,
					left: 0,
				}}
				{...props}
				{...{
					"data-page-number": pageNumber,
					"data-text-layer-requested-mode": requestedMode,
					"data-text-layer-mode": renderMode,
					"data-text-layer-fallback-reason": fallbackReason ?? undefined,
				}}
				ref={textContainerRef}
			/>
		);
	},
);

TextLayer.displayName = "TextLayer";
