import { type JSX, memo } from "react";

import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";

export const CustomLayer = memo(
	({ children }: { children: (pageNumber: number) => JSX.Element }) => {
		const pageNumber = usePDFPageNumber();

		return children(pageNumber);
	},
);

CustomLayer.displayName = "CustomLayer";
