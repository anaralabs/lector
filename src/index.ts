export { Root } from "./components/root";
export { Pages } from "./components/pages";
export { Page } from "./components/page";
export {
  CurrentPage,
  TotalPages,
  NextPage,
  PreviousPage,
} from "./components/page-number";
export { Thumbnail, Thumbnails } from "./components/thumbnails";
export { ZoomIn, ZoomOut, CurrentZoom } from "./components/zoom";
export { Outline, OutlineChildItems, OutlineItem } from "./components/outline";
export { Search } from "./components/search";
export { SelectionTooltip } from "./components/selection-tooltip";

export { CanvasLayer } from "./components/layers/canvas-layer";
export { HighlightLayer } from "./components/layers/higlight-layer";
export { TextLayer } from "./components/layers/text-layer";
export { AnnotationLayer } from "./components/layers/annotation-layer";
export { CustomLayer } from "./components/layers/custom-layer";

export { usePdf } from "./internal";
export { usePdfJump } from "./hooks/pages/usePdfJump";
export {
  useSearch,
  type SearchResult,
  type SearchResults,
} from "./hooks/search/useSearch";
export { calculateHighlightRects } from "./hooks/search/useSearchPosition";
export { LinkService } from "./hooks/usePDFLinkService";
