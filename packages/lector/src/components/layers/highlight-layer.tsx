import { Slot } from "@radix-ui/react-slot";
import {
	type ComponentPropsWithoutRef,
	type ElementRef,
	forwardRef,
} from "react";

import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";
import { type HighlightRect, usePdf } from "../../internal";

interface HighlightLayerProps extends ComponentPropsWithoutRef<"div"> {
	asChild?: boolean;
}

const convertToPercentString = (rect: Omit<HighlightRect, "pageNumber">) => {
	return {
		top: `${rect.top}%`,
		left: `${rect.left}%`,
		height: `${rect.height}%`,
		width: `${rect.width}%`,
	};
};

type Dimensions = {
	top: string | number;
	left: string | number;
	height: string | number;
	width: string | number;
};
export const HighlightLayer = forwardRef<
	ElementRef<"div">,
	HighlightLayerProps
>(({ asChild, className, style, ...props }, ref) => {
	const pageNumber = usePDFPageNumber();
	const highlights = usePdf((state) => state.highlights);

	const Comp = asChild ? Slot : "div";

	const rects = highlights.filter((area) => area.pageNumber === pageNumber);

	if (!rects?.length) return null;

	return (
		<>
			{rects.map((rect, index) => {
				const { pageNumber, type, style: customStyle, ...coordinates } = rect;

				let dimensions: Dimensions = coordinates;
				if (type === "percent") {
					dimensions = convertToPercentString(rect);
				}

				const customStyles = customStyle ? customStyle(rect) : {};

				return (
					<Comp
						ref={ref}
						// biome-ignore lint/suspicious/noArrayIndexKey: <index for now
						key={`highlight-${pageNumber}-${index}`}
						className={className}
						style={{
							position: "absolute",
							...dimensions,
							pointerEvents: "none",
							zIndex: 30,
							...style,
							...customStyles,
						}}
						{...props}
					>
						{props.children}
					</Comp>
				);
			})}
		</>
	);
});

HighlightLayer.displayName = "HighlightLayer";
