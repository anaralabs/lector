import type { PDFDocumentProxy } from "pdfjs-dist";
import type { RefProxy } from "pdfjs-dist/types/src/display/api";
import type { IPDFLinkService } from "pdfjs-dist/types/web/interfaces";
import { createContext, useContext, useEffect, useRef } from "react";

export class LinkService implements IPDFLinkService {
	_pdfDocumentProxy?: PDFDocumentProxy;
	externalLinkEnabled = true;
	isInPresentationMode = false;

	_currentPageNumber = 0;
	_pageNavigationCallback?: (pageNumber: number) => void;

	get pdfDocumentProxy(): PDFDocumentProxy {
		if (!this._pdfDocumentProxy) {
			throw new Error("pdfDocumentProxy is not set");
		}

		return this._pdfDocumentProxy;
	}

	get pagesCount() {
		return this._pdfDocumentProxy?.numPages || 0;
	}

	get page() {
		return this._currentPageNumber;
	}

	set page(value: number) {
		this._currentPageNumber = value;
		if (this._pageNavigationCallback) {
			this._pageNavigationCallback(value);
		}
	}

	// Required for link annotations to work
	setDocument(pdfDocument: PDFDocumentProxy): void {
		this._pdfDocumentProxy = pdfDocument;
	}

	setViewer(): void {
		// Intentionally empty
	}

	getDestinationHash(dest: unknown[]): string {
		if (!dest) return "";

		// Handle URL destinations differently from internal destinations
		const destRef = dest[0];

		// If it's a URL destination (contains a url property)
		if (
			dest.length > 1 &&
			typeof dest[1] === "object" &&
			dest[1] !== null &&
			"url" in dest[1]
		) {
			const urlDest = dest[1] as { url: string };
			return urlDest.url;
		}

		// Handle different destination reference types
		if (destRef && typeof destRef === "object") {
			if ("num" in destRef) {
				const numRef = destRef as { num: number };
				return `#page=${numRef.num + 1}`;
			}

			if ("gen" in destRef) {
				const genRef = destRef as { gen: number; num?: number };
				const refNum = genRef.num ?? 0;
				return `#page=${refNum + 1}`;
			}
		}

		// Handle numeric page references
		if (typeof destRef === "number") {
			return `#page=${destRef + 1}`;
		}

		// Fallback
		return `#dest-${String(dest)}`;
	}

	getAnchorUrl(hash: string): string {
		// Direct URL links should be returned as-is
		if (hash.startsWith("http://") || hash.startsWith("https://")) {
			return hash;
		}

		return `#${hash}`;
	}

	addLinkAttributes(
		link: HTMLAnchorElement,
		url: string,
		newWindow?: boolean | undefined,
	): void {
		if (!link) return;

		// Handle external URLs
		const isExternalLink =
			url.startsWith("http://") || url.startsWith("https://");

		if (isExternalLink && this.externalLinkEnabled) {
			link.href = url;
			link.target = newWindow === false ? "" : "_blank";
			link.rel = "noopener noreferrer";
		} else if (!isExternalLink) {
			// Internal link
			link.href = url;
			link.target = "";
		} else {
			// External link but disabled
			link.href = "#";
			link.target = "";
		}
	}

	async goToDestination(dest: string | unknown[] | Promise<unknown[]>) {
		let explicitDest: unknown[] | null;

		if (typeof dest === "string") {
			explicitDest = await this.pdfDocumentProxy.getDestination(dest);
		} else if (Array.isArray(dest)) {
			explicitDest = dest;
		} else {
			explicitDest = await dest;
		}

		if (!explicitDest) {
			return;
		}

		// Check if it's a URL destination
		if (
			explicitDest.length > 1 &&
			typeof explicitDest[1] === "object" &&
			explicitDest[1] !== null &&
			"url" in explicitDest[1]
		) {
			return;
		}

		// Handle the destination reference
		const destRef = explicitDest[0];
		let pageIndex: number;

		if (destRef && typeof destRef === "object") {
			if ("num" in destRef) {
				try {
					const refProxy = destRef as RefProxy;
					pageIndex = await this.pdfDocumentProxy.getPageIndex(refProxy);
				} catch (_error) {
					return;
				}
			} else {
				return;
			}
		} else if (typeof destRef === "number") {
			pageIndex = destRef;
		} else {
			return;
		}

		// Navigate to the page
		const pageNumber = pageIndex + 1;

		// Trigger the navigation callback
		if (this._pageNavigationCallback) {
			this._pageNavigationCallback(pageNumber);
		}
	}

	executeNamedAction(): void {
		// Intentionally empty
	}

	navigateTo(dest: string | unknown[] | Promise<unknown[]>): void {
		this.goToDestination(dest);
	}

	get rotation() {
		// We don't track rotation
		return 0;
	}

	set rotation(_value: number) {
		// Intentionally empty
	}

	goToPage(_page_valuer: number): void {
		// if (pageNumber >= 1 && pageNumber <= this.pagesCount) {
		// 	if (this._pageNavigationCallback) {
		// 		this._pageNavigationCallback(pageNumber);
		// 	}
		// }
	}

	setHash(hash: string): void {
		if (hash.startsWith("#page=")) {
			const pageNumber = parseInt(hash.substring(6), 10);
			if (!Number.isNaN(pageNumber)) {
				this.goToPage(pageNumber);
			}
		}
	}

	executeSetOCGState(): void {
		// Intentionally empty
	}

	// Method to register navigation callback
	registerPageNavigationCallback(callback: (pageNumber: number) => void): void {
		this._pageNavigationCallback = callback;
	}

	// Method to unregister navigation callback
	unregisterPageNavigationCallback(): void {
		this._pageNavigationCallback = undefined;
	}
}

export const useCreatePDFLinkService = (
	pdfDocumentProxy: PDFDocumentProxy | null,
) => {
	const linkService = useRef<LinkService>(new LinkService());

	useEffect(() => {
		if (pdfDocumentProxy) {
			linkService.current._pdfDocumentProxy = pdfDocumentProxy;
			linkService.current.setDocument(pdfDocumentProxy);
		}
	}, [pdfDocumentProxy]);

	return linkService.current;
};

// Create a default LinkService instance for the context
const defaultLinkService = new LinkService();

export const PDFLinkServiceContext =
	createContext<LinkService>(defaultLinkService);

export const usePDFLinkService = () => {
	return useContext(PDFLinkServiceContext);
};
