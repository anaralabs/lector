import clsx from "clsx";
import { type HTMLProps, memo } from "react";

import { useTextLayer } from "../../hooks/layers/useTextLayer";

export const TextLayer = memo(
	({ className, style, ...props }: HTMLProps<HTMLDivElement>) => {
		const { textContainerRef, pageNumber, renderMode, fallbackReason } =
			useTextLayer();

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
					"data-text-layer-mode": renderMode,
					"data-text-layer-fallback-reason": fallbackReason ?? undefined,
				}}
				ref={textContainerRef}
			/>
		);
	},
);

TextLayer.displayName = "TextLayer";
