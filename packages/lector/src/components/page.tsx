import {
	type CSSProperties,
	type HTMLProps,
	memo,
	type ReactNode,
} from "react";

import { PDFPageNumberContext } from "../hooks/usePdfPageNumber";
import { usePdf } from "../internal";
import { createDarkModeColorMap } from "../lib/dark-mode";
import { PageLoadingBoundary } from "./page-loading-boundary";
import { Primitive } from "./primitive";

export const Page = memo(
	({
		children,
		pageNumber = 1,
		style,
		...props
	}: HTMLProps<HTMLDivElement> & {
		children: ReactNode;
		pageNumber?: number;
	}) => {
		const loaded = usePdf((state) => state.isPageLoaded(pageNumber));
		const getPage = usePdf((state) => state.getPdfPageProxy);
		const proxy = loaded ? getPage(pageNumber) : undefined;
		const viewport = usePdf((state) => state.viewports[pageNumber - 1]);
		const colorScheme = usePdf((state) => state.colorScheme);
		const darkModeColors = usePdf((state) => state.darkModeColors);

		// Match the canvas pixels: white maps exactly onto the dark palette's
		// background, so pages never flash light while (re)rendering.
		const pageBackground =
			colorScheme === "dark"
				? createDarkModeColorMap(darkModeColors)("#ffffff")
				: "white";

		const width =
			viewport?.width ?? (proxy?.view[2] ?? 0) - (proxy?.view[0] ?? 0);
		const height =
			viewport?.height ?? (proxy?.view[3] ?? 0) - (proxy?.view[1] ?? 0);

		return (
			<PDFPageNumberContext.Provider value={pageNumber}>
				<Primitive.div
					style={{
						display: "block",
					}}
				>
					<div
						style={
							{
								"--scale-factor": 1,
								"--total-scale-factor": 1,
								backgroundColor: pageBackground,
								position: "relative",
								width,
								height,
								...style,
							} as CSSProperties
						}
						aria-busy={!loaded || undefined}
						{...props}
					>
						<PageLoadingBoundary pageNumber={pageNumber}>
							{children}
						</PageLoadingBoundary>
					</div>
				</Primitive.div>
			</PDFPageNumberContext.Provider>
		);
	},
);

Page.displayName = "Page";
