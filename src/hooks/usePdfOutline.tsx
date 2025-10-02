import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useState } from "react";

import { usePdf } from "../internal";
import { cancellable } from "../lib/cancellable";

export const usePDFOutline = () => {
	const pdfDocumentProxy = usePdf((state) => state.pdfDocumentProxy);
	const [outline, setOutline] =
		useState<Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>>();

	useEffect(() => {
		const { promise: outline, cancel } = cancellable(
			pdfDocumentProxy.getOutline(),
		);

		outline.then(
			(result) => {
				setOutline(result);
			},
			() => {},
		);

		return () => {
			cancel();
		};
	}, [pdfDocumentProxy]);

	return outline;
};
