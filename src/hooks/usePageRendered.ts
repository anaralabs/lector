import { usePdf } from "../internal";

export const usePageRendered = (pageNumber: number): boolean =>
	usePdf((state) => !!state.renderedPages[pageNumber]);
