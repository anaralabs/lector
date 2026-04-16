import { forwardRef, type HTMLProps, type ReactNode, useEffect } from "react";

import {
	usePDFDocumentContext,
	type usePDFDocumentParams,
} from "../hooks/document/document";
import { clearBitmapCache } from "../hooks/layers/useCanvasLayer";
import {
	PDFLinkServiceContext,
	useCreatePDFLinkService,
} from "../hooks/usePDFLinkService";
import { PDFStore } from "../internal";
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
			documentOptions,
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
			documentOptions,
		});

		const linkService = useCreatePDFLinkService(
			initialState?.pdfDocumentProxy ?? null,
		);

		const documentId = initialState?.pdfDocumentProxy?.fingerprints?.[0];
		useEffect(() => {
			return () => {
				clearBitmapCache();
			};
		}, [documentId]);

		return (
			<Primitive.div ref={ref} {...props}>
				{initialState ? (
					<PDFStore.Provider initialValue={initialState}>
						<PDFLinkServiceContext.Provider value={linkService}>
							{children}
						</PDFLinkServiceContext.Provider>
					</PDFStore.Provider>
				) : (
					(loader ?? "Loading...")
				)}
			</Primitive.div>
		);
	},
);

Root.displayName = "Root";
