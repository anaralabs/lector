import { ComponentPropsWithoutRef } from 'react';
import { Context } from 'react';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';
import { ForwardRefExoticComponent } from 'react';
import { FunctionComponent } from 'react';
import { HTMLProps } from 'react';
import { JSX as JSX_2 } from 'react/jsx-runtime';
import { JSX as JSX_3 } from 'react';
import { MemoExoticComponent } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsDist } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { default as React_2 } from 'react';
import { ReactElement } from 'react';
import { ReactNode } from 'react';
import { RefAttributes } from 'react';
import { StoreApi } from 'zustand';
import type { TypedArray } from 'pdfjs-dist/types/src/display/api';
import { UseBoundStore } from 'zustand';
import { useFloating } from '@floating-ui/react';
import { useInteractions } from '@floating-ui/react';
import type { Virtualizer } from '@tanstack/react-virtual';

declare interface Annotation {
    id: string;
    pageNumber: number;
    highlights: HighlightRect_alias_2[];
    underlines?: HighlightRect_alias_2[];
    color: string;
    borderColor: string;
    comment?: string;
    createdAt: Date;
    updatedAt: Date;
    metadata?: Record<string, unknown>;
    isCommentPending?: boolean;
}
export { Annotation }
export { Annotation as Annotation_alias_1 }

export declare const AnnotationHighlightLayer: ({ className, style, renderTooltipContent, renderHoverTooltipContent, tooltipClassName, highlightClassName, underlineClassName, commentIconPosition, commmentIcon, commentIconClassName, focusedAnnotationId, focusedHoverAnnotationId, onAnnotationClick, onAnnotationTooltipClose, hoverTooltipClassName, }: AnnotationHighlightLayerProps) => JSX_2.Element | null;

declare interface AnnotationHighlightLayerProps {
    className?: string;
    style?: React_2.CSSProperties;
    renderTooltipContent: (props: AnnotationTooltipContentProps) => React_2.ReactNode;
    renderHoverTooltipContent: (props: {
        annotation: Annotation;
        onClose: () => void;
    }) => React_2.ReactNode;
    focusedAnnotationId?: string;
    commmentIcon?: React_2.ReactNode;
    focusedHoverAnnotationId?: string;
    onAnnotationClick?: (annotation: Annotation) => void;
    onAnnotationTooltipClose?: (annotation: Annotation) => void;
    tooltipClassName?: string;
    hoverTooltipClassName?: string;
    highlightClassName?: string;
    commentIconPosition?: "highlight" | "page";
    underlineClassName?: string;
    commentIconClassName?: string;
}

/**
 * AnnotationLayer renders PDF annotations like links, highlights, and form fields.
 *
 * @param renderForms - Whether to render form fields in the annotation layer.
 * @param externalLinksEnabled - Whether external links should be clickable. When false, external links won't open.
 * @param jumpOptions - Options for page navigation behavior when clicking internal links.
 *                      See `usePdfJump` hook for available options.
 */
export declare const AnnotationLayer: MemoExoticComponent<({ renderForms, externalLinksEnabled, jumpOptions, className, style, ...props }: AnnotationLayerParams & HTMLProps<HTMLDivElement>) => JSX_2.Element>;

declare interface AnnotationLayerParams {
    /**
     * Whether to render forms.
     */
    renderForms?: boolean;
    /**
     * Whether external links are enabled.
     * If false, external links will not open.
     * @default true
     */
    externalLinksEnabled?: boolean;
    /**
     * Options to pass to the jumpToPage function when navigating.
     * See usePdfJump hook for available options.
     * @default { behavior: "smooth", align: "start" }
     */
    jumpOptions?: Parameters<ReturnType<typeof usePdfJump>["jumpToPage"]>[1];
}

declare interface AnnotationState {
    annotations: Annotation[];
    addAnnotation: (annotation: Annotation) => void;
    updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
    deleteAnnotation: (id: string) => void;
    setAnnotations: (annotations: Annotation[]) => void;
}

export declare const AnnotationTooltip: ({ annotation, children, renderTooltipContent, hoverTooltipContent, onOpenChange, className, focusedOpenId, focusedHoverOpenId, hoverClassName, isOpen: controlledIsOpen, hoverIsOpen: controlledHoverIsOpen, }: AnnotationTooltipProps) => JSX_2.Element;

export declare type AnnotationTooltipContentProps = {
    annotation: Annotation;
    onClose: () => void;
    setPosition?: (position: "top" | "bottom" | undefined) => void;
};

declare interface AnnotationTooltipProps {
    annotation: Annotation;
    children: React.ReactNode;
    renderTooltipContent: (props: AnnotationTooltipContentProps) => React.ReactNode;
    hoverTooltipContent?: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
    isOpen?: boolean;
    focusedOpenId?: string;
    focusedHoverOpenId?: string;
    className?: string;
    hoverClassName?: string;
    hoverIsOpen?: boolean;
    renderHoverTooltipContent?: (props: {
        annotation: Annotation;
        onClose: () => void;
    }) => React.ReactNode;
}

/**
 * Calculates the highlight rectangles for a given text match.
 *
 * @param pageProxy - The PDF page proxy object
 * @param textMatch - An object containing:
 *   - pageNumber: The page number where the match is found
 *   - text: The text content containing the match (usually a larger chunk of text)
 *   - matchIndex: The index within the text where the match starts
 *   - searchText: (Optional) The exact search term to highlight. If provided, only highlights
 *                 this exact term instead of the entire text. If not provided, highlights the full text.
 * @returns An array of HighlightRect objects representing the areas to highlight
 */
export declare function calculateHighlightRects(pageProxy: PDFPageProxy, textMatch: TextPosition): Promise<HighlightRect[]>;

export declare const cancellable: <T extends Promise<unknown>>(promise: T) => {
    promise: T;
    cancel: () => void;
};

export declare const CanvasLayer: MemoExoticComponent<({ style, background, ...props }: HTMLProps<HTMLCanvasElement> & {
background?: string;
}) => JSX_2.Element>;

export declare const clamp: (value: number, minimum: number, maximum: number) => number;

export declare function clampScaleForPage(targetScale: number, pageWidth: number, pageHeight: number): number;

declare type CollapsibleSelection = {
    highlights: HighlightRect[];
    underlines?: HighlightRect[];
    text: string;
    isCollapsed: boolean;
};

declare type ColoredHighlight = {
    color: string;
    rectangles: HighlightRect[];
    pageNumber: number;
    text: string;
    uuid: string;
};
export { ColoredHighlight }
export { ColoredHighlight as ColoredHighlight_alias_1 }

export declare const ColoredHighlightLayer: ({ onHighlight, }: ColoredHighlightLayerProps) => JSX_2.Element;

declare type ColoredHighlightLayerProps = {
    onHighlight?: (highlight: ColoredHighlight) => void;
};

export declare const CurrentPage: ({ ...props }: HTMLProps<HTMLInputElement>) => JSX_2.Element;

export declare const CurrentZoom: ({ ...props }: HTMLProps<HTMLInputElement>) => JSX_2.Element;

export declare const CustomLayer: MemoExoticComponent<({ children }: {
children: (pageNumber: number) => JSX_3.Element;
}) => JSX_3.Element>;

export declare const ensureAnnotationLayerStyles: () => void;

export declare const firstMemo: <T>(first: boolean, memo: unknown, initializer: () => T) => T;

export declare const getEndOfHighlight: (selection: ColoredHighlight) => number;

export declare const getFitWidthZoom: (containerWidth: number, viewports: PageViewport[], zoomOptions: {
    minZoom: number;
    maxZoom: number;
}) => number;

export declare const getMidHeightOfHighlightLine: (selection: ColoredHighlight) => number;

export declare const HighlightLayer: ForwardRefExoticComponent<HighlightLayerProps & RefAttributes<HTMLDivElement>>;

declare interface HighlightLayerProps extends ComponentPropsWithoutRef<"div"> {
    asChild?: boolean;
}

declare type HighlightRect = {
    pageNumber: number;
    top: number;
    left: number;
    height: number;
    width: number;
    type?: "pixels" | "percent";
    style?: (rect: HighlightRect) => React_2.CSSProperties;
};
export { HighlightRect }
export { HighlightRect as HighlightRect_alias_1 }

export declare interface HighlightRect_alias_2 {
    height: number;
    left: number;
    top: number;
    width: number;
    pageNumber: number;
}

export declare interface InitialPDFState {
    pdfDocumentProxy: PDFDocumentProxy;
    pageProxies: PDFPageProxy[];
    viewports: Array<PageViewport>;
    zoom: number;
    isZoomFitWidth?: boolean;
    zoomOptions?: ZoomOptions;
}

export declare function isScrollActive(idleMs?: number): boolean;

export declare class LinkService {
    _pdfDocumentProxy?: PDFDocumentProxy;
    externalLinkEnabled: boolean;
    isInPresentationMode: boolean;
    _currentPageNumber: number;
    _pageNavigationCallback?: (pageNumber: number) => void;
    get pdfDocumentProxy(): PDFDocumentProxy;
    get pagesCount(): number;
    get page(): number;
    set page(value: number);
    setDocument(pdfDocument: PDFDocumentProxy): void;
    setViewer(): void;
    getDestinationHash(dest: unknown[]): string;
    getAnchorUrl(hash: string): string;
    addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean | undefined): void;
    goToDestination(dest: string | unknown[] | Promise<unknown[]>): Promise<void>;
    executeNamedAction(): void;
    navigateTo(dest: string | unknown[] | Promise<unknown[]>): void;
    get rotation(): number;
    set rotation(_value: number);
    goToPage(_page_valuer: number): void;
    setHash(hash: string): void;
    executeSetOCGState(): void;
    registerPageNavigationCallback(callback: (pageNumber: number) => void): void;
    unregisterPageNavigationCallback(): void;
}

export declare const loadPdfJs: () => Promise<pdfjsDist>;

export declare const MAX_CANVAS_DIMENSION = 32767;

export declare const MAX_CANVAS_PIXELS = 16777216;

export declare function msSinceScroll(): number;

export declare const NextPage: () => void;

export declare function notifyScrollActivity(): void;

export declare const Outline: ({ children, ...props }: HTMLProps<HTMLUListElement> & {
    children: ReactElement<typeof OutlineItem>;
}) => JSX_2.Element;

export declare const OutlineChildItems: ({ ...props }: HTMLProps<HTMLUListElement> & {
    children?: ReactElement<typeof OutlineItem>[];
}) => JSX_2.Element;

export declare const OutlineItem: FunctionComponent<OutlineItemProps>;

declare interface OutlineItemProps extends HTMLProps<HTMLDivElement> {
    level?: number;
    item?: OutlineItemType;
    children?: ReactElement<typeof OutlineChildItems>;
    outlineItem?: ReactElement<typeof OutlineItem>;
}

declare type OutlineItemType = NonNullable<ReturnType<typeof usePDFOutline>>[number];

export declare const Page: MemoExoticComponent<({ children, pageNumber, style, ...props }: HTMLProps<HTMLDivElement> & {
children: ReactNode;
pageNumber?: number;
}) => JSX_2.Element>;

export declare const Pages: ({ children, gap, virtualizerOptions, initialOffset, onOffsetChange, ...props }: HTMLProps<HTMLDivElement> & {
    virtualizerOptions?: {
        overscan?: number;
    };
    gap?: number;
    children: ReactElement;
    initialOffset?: number;
    onOffsetChange?: (offset: number) => void;
}) => JSX_2.Element;

export declare const PDFLinkServiceContext: Context<LinkService>;

declare interface PDFState {
    pdfDocumentProxy: PDFDocumentProxy;
    zoom: number;
    updateZoom: (zoom: number | ((prevZoom: number) => number), isZoomFitWidth?: boolean) => void;
    isZoomFitWidth: boolean;
    zoomFitWidth: () => void;
    isPinching: boolean;
    setIsPinching: (isPinching: boolean) => void;
    currentPage: number;
    setCurrentPage: (pageNumber: number) => void;
    viewports: Array<PageViewport>;
    viewportRef: React_2.MutableRefObject<HTMLDivElement | null>;
    pageProxies: PDFPageProxy[];
    textContent: TextContent[];
    setTextContent: (textContents: TextContent[]) => void;
    zoomOptions: Required<ZoomOptions>;
    virtualizer: PDFVirtualizer | null;
    setVirtualizer: (virtualizer: PDFVirtualizer) => void;
    highlights: HighlightRect[];
    setHighlight: (higlights: HighlightRect[]) => void;
    getPdfPageProxy: (pageNumber: number) => PDFPageProxy;
    customSelectionRects: HighlightRect[];
    setCustomSelectionRects: (rects: HighlightRect[]) => void;
    coloredHighlights: ColoredHighlight[];
    addColoredHighlight: (value: ColoredHighlight) => void;
    deleteColoredHighlight: (uuid: string) => void;
    renderedPages: Record<number, true>;
    markPageRendered: (pageNumber: number) => void;
    unmarkPageRendered: (pageNumber: number) => void;
}

export declare const PDFStore: {
    useContext: () => StoreApi<PDFState>;
    Context: React_2.Context<StoreApi<PDFState>>;
    Provider: (props: {
        children?: React_2.ReactNode;
        initialValue: InitialPDFState;
    }) => JSX_2.Element;
};

export declare type PDFVirtualizer = Virtualizer<any, any>;

export declare const PreviousPage: () => void;

export declare const Root: ForwardRefExoticComponent<Omit<HTMLProps<HTMLDivElement> & usePDFDocumentParams & {
loader?: ReactNode;
}, "ref"> & RefAttributes<unknown>>;

export declare const Search: ({ children, loading }: SearchProps) => ReactNode;

declare interface SearchOptions {
    threshold?: number;
    limit?: number;
    textSize?: number;
}

declare interface SearchProps {
    children: React.ReactNode;
    loading?: React.ReactNode;
}

export declare interface SearchResult {
    pageNumber: number;
    text: string;
    score: number;
    matchIndex: number;
    isExactMatch: boolean;
    searchText?: string;
}

export declare interface SearchResults {
    exactMatches: SearchResult[];
    fuzzyMatches: SearchResult[];
    hasMoreResults: boolean;
}

export declare const SelectionTooltip: ({ children }: SelectionTooltipProps) => JSX_2.Element;

declare interface SelectionTooltipProps {
    children: React_2.ReactNode;
}

export declare type Source = string | URL | TypedArray | ArrayBuffer | DocumentInitParameters;

export declare const subscribeToViewportInvalidation: (viewport: HTMLDivElement, callback: ViewportCallback) => () => void;

declare type TextContent = {
    pageNumber: number;
    text: string;
};

export declare const TextLayer: MemoExoticComponent<({ className, style, ...props }: HTMLProps<HTMLDivElement>) => JSX_2.Element>;

declare interface TextPosition {
    pageNumber: number;
    text: string;
    matchIndex: number;
    searchText?: string;
}

export declare const Thumbnail: ({ pageNumber, ...props }: HTMLProps<HTMLCanvasElement> & {
    pageNumber?: number;
}) => JSX_2.Element;

export declare const Thumbnails: ({ children, ...props }: HTMLProps<HTMLDivElement> & {
    children: ReactElement<typeof Thumbnail>;
}) => JSX_2.Element;

export declare const TotalPages: ({ ...props }: HTMLProps<HTMLDivElement>) => JSX_2.Element;

declare const useAnnotations: UseBoundStore<StoreApi<AnnotationState>>;
export { useAnnotations }
export { useAnnotations as useAnnotations_alias_1 }

export declare const useAnnotationTooltip: ({ annotation, onOpenChange, position, isOpen: controlledIsOpen, }: UseAnnotationTooltipProps) => UseAnnotationTooltipReturn;

declare interface UseAnnotationTooltipProps {
    annotation: Annotation;
    onOpenChange?: (open: boolean) => void;
    position?: "top" | "bottom" | "left" | "right";
    isOpen?: boolean;
}

declare interface UseAnnotationTooltipReturn {
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
    refs: ReturnType<typeof useFloating>["refs"];
    floatingStyles: ReturnType<typeof useFloating>["floatingStyles"];
    getFloatingProps: ReturnType<typeof useInteractions>["getFloatingProps"];
    getReferenceProps: ReturnType<typeof useInteractions>["getReferenceProps"];
}

export declare const useCreatePDFLinkService: (pdfDocumentProxy: PDFDocumentProxy | null) => LinkService;

declare const usePageRendered: (pageNumber: number) => boolean;
export { usePageRendered }
export { usePageRendered as usePageRendered_alias_1 }

declare const usePdf: <T>(selector: (state: PDFState) => T) => T;
export { usePdf }
export { usePdf as usePdf_alias_1 }

export declare const usePDFDocumentContext: ({ onDocumentLoad, source, initialRotation, isZoomFitWidth, zoom, zoomOptions, documentOptions, }: usePDFDocumentParams) => {
    initialState: InitialPDFState | null | undefined;
};

export declare interface usePDFDocumentParams {
    /**
     * The URL of the PDF file to load.
     */
    source: Source;
    onDocumentLoad?: ({ proxy, source, }: {
        proxy: PDFDocumentProxy;
        source: Source;
    }) => void;
    initialRotation?: number;
    isZoomFitWidth?: boolean;
    zoom?: number;
    zoomOptions?: ZoomOptions;
    /**
     * Override or extend the PDF.js DocumentInitParameters passed to getDocument().
     * These take highest precedence over both the source object and lector's defaults.
     * Must be a stable reference (module-level constant or useMemo) to avoid reloading the document.
     */
    documentOptions?: Partial<DocumentInitParameters>;
}

export declare const usePdfJump: () => {
    jumpToPage: (pageIndex: number, options?: {
        align?: "start" | "center" | "end" | "auto";
        behavior?: "auto" | "smooth";
    }) => void;
    jumpToOffset: (offset: number) => void;
    jumpToHighlightRects: (rects: HighlightRect[], type: "pixels" | "percent", align?: "start" | "center", additionalOffset?: number) => void;
    scrollToHighlightRects: (rects: HighlightRect[], type: "pixels" | "percent", align?: "start" | "center", additionalOffset?: number) => void;
};

export declare const usePDFLinkService: () => LinkService;

declare const usePDFOutline: () => {
    title: string;
    bold: boolean;
    italic: boolean;
    color: Uint8ClampedArray;
    dest: string | Array<any> | null;
    url: string | null;
    unsafeUrl: string | undefined;
    newWindow: boolean | undefined;
    count: number | undefined;
    items: Array<any>;
}[] | undefined;

export declare const usePDFPageNumber: () => number;

/**
 * Returns the zustand store handle so consumers can imperatively read state
 * (via `.getState()`) or subscribe outside React (via `.subscribe()`) without
 * triggering component re-renders.
 *
 * Useful for things like event handlers that need the current zoom value but
 * shouldn't re-render their component on every zoom change.
 */
declare const usePdfStore: () => StoreApi<PDFState>;
export { usePdfStore }
export { usePdfStore as usePdfStore_alias_1 }

export declare const useSearch: () => {
    textContent: {
        pageNumber: number;
        text: string;
    }[];
    keywords: string[];
    searchResults: SearchResults;
    search: (searchText: string, options?: SearchOptions) => SearchResults;
};

export declare const useSelectionDimensions: () => {
    getDimension: () => {
        highlights: HighlightRect[];
        text: string;
        isCollapsed: boolean;
    } | undefined;
    getSelection: () => CollapsibleSelection;
    getAnnotationDimension: () => {
        highlights: HighlightRect[];
        underlines: HighlightRect[];
        text: string;
        isCollapsed: boolean;
    } | undefined;
};

declare type ViewportCallback = () => void;

export declare const ZoomIn: ({ ...props }: HTMLProps<HTMLButtonElement>) => JSX_2.Element;

export declare interface ZoomOptions {
    minZoom?: number;
    maxZoom?: number;
}

export declare const ZoomOut: ({ ...props }: HTMLProps<HTMLButtonElement>) => JSX_2.Element;

export { }
