import clsx from "clsx";
import type { HTMLProps } from "react";

import { useTextLayer } from "../../hooks/layers/useTextLayer";

export const TextLayer = ({
	className,
	style,
	...props
}: HTMLProps<HTMLDivElement>) => {
	const { textContainerRef, pageNumber } = useTextLayer();

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
			}}
			ref={textContainerRef}
		/>
	);
};
