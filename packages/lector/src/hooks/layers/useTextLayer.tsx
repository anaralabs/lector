import { useRef } from "react";

import { usePdf } from "../../internal";
import { usePDFPageNumber } from "../usePdfPageNumber";

export const useTextLayer = () => {
	const textContainerRef = useRef<HTMLDivElement>(null);
	const pageNumber = usePDFPageNumber();
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));

	return {
		textContainerRef,
		pageNumber: pdfPageProxy.pageNumber,
	};
};
