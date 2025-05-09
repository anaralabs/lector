export type { AnnotationTooltipContentProps } from "./components/annotation-tooltip";
export { AnnotationTooltip } from "./components/annotation-tooltip";
export { AnnotationHighlightLayer } from "./components/layers/annotation-highlight-layer";
export { AnnotationLayer } from "./components/layers/annotation-layer";
export { CanvasLayer } from "./components/layers/canvas-layer";
export { ColoredHighlightLayer } from "./components/layers/colored-highlight/colored-highlight-layer";
export { CustomLayer } from "./components/layers/custom-layer";
export { HighlightLayer } from "./components/layers/highlight-layer";
export { TextLayer } from "./components/layers/text-layer";
export { Outline, OutlineChildItems, OutlineItem } from "./components/outline";
export { Page } from "./components/page";
export {
  CurrentPage,
  NextPage,
  PreviousPage,
  TotalPages,
} from "./components/page-number";
export { Pages } from "./components/pages";
export { Root } from "./components/root";
export { Search } from "./components/search";
export { SelectionTooltip } from "./components/selection-tooltip";
export { Thumbnail, Thumbnails } from "./components/thumbnails";
export { CurrentZoom, ZoomIn, ZoomOut } from "./components/zoom";
export { usePdfJump } from "./hooks/pages/usePdfJump";
export {
  type SearchResult,
  type SearchResults,
  useSearch,
} from "./hooks/search/useSearch";
export { calculateHighlightRects } from "./hooks/search/useSearchPosition";
export type { Annotation } from "./hooks/useAnnotations";
export { useAnnotations } from "./hooks/useAnnotations";
export { LinkService } from "./hooks/usePDFLinkService";
export { usePDFPageNumber } from "./hooks/usePdfPageNumber";
export { useSelectionDimensions } from "./hooks/useSelectionDimensions";
export { type ColoredHighlight, type HighlightRect, usePdf } from "./internal";