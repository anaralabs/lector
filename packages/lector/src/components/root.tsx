import { forwardRef, type HTMLProps, type ReactNode, useEffect } from "react";

import {
	usePDFDocumentContext,
	type usePDFDocumentParams,
} from "../hooks/document/document";
import {
	PDFLinkServiceContext,
	useCreatePDFLinkService,
} from "../hooks/usePDFLinkService";
import { PDFStore } from "../internal";
import { bitmapCache } from "../lib/bitmap-cache";
import { Primitive } from "./primitive";

export const Root = forwardRef(
	(
		{
			children,
			source,
			loader,
			onDocumentLoad,
			isZoomFitWidth,
			zoom,
			zoomOptions,
			...props
		}: HTMLProps<HTMLDivElement> &
			usePDFDocumentParams & {
				loader?: ReactNode;
			},
		ref,
	) => {
		const { initialState } = usePDFDocumentContext({
			source,
			onDocumentLoad,
			isZoomFitWidth,
			zoom,
			zoomOptions,
		});

		const linkService = useCreatePDFLinkService(
			initialState?.pdfDocumentProxy ?? null,
		);

		useEffect(() => {
			if (initialState?.pdfDocumentProxy) {
				bitmapCache.bindDocument(initialState.pdfDocumentProxy);
			}
		}, [initialState?.pdfDocumentProxy]);

		return (
			<Primitive.div ref={ref} {...props}>
				{initialState ? (
					<PDFStore.Provider initialValue={initialState}>
						<PDFLinkServiceContext.Provider value={linkService}>
							{children}
						</PDFLinkServiceContext.Provider>
					</PDFStore.Provider>
				) : (
					loader || "Loading..."
				)}
			</Primitive.div>
		);
	},
);

Root.displayName = "Root";
