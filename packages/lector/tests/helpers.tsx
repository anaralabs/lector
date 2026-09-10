import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { ReactNode } from "react";
import { PDFStore } from "../src/internal";

export function wrapperFor(pages: PDFPageProxy[] = []) {
	const initialValue = {
		pdfDocumentProxy: {
			numPages: pages.length,
			fingerprints: ["test"],
		} as PDFDocumentProxy,
		pageProxies: pages,
		viewports: pages.map(() => ({ width: 600, height: 800 }) as PageViewport),
		zoom: 1,
	};
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<PDFStore.Provider initialValue={initialValue}>
				{children}
			</PDFStore.Provider>
		);
	};
}
