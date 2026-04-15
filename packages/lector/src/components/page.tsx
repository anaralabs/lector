import {
	type CSSProperties,
	type HTMLProps,
	memo,
	type ReactNode,
	useEffect,
} from "react";

import { PDFPageNumberContext } from "../hooks/usePdfPageNumber";
import { usePdf } from "../internal";
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
		const hasProxy = usePdf(
			(state) => state.pageProxies[pageNumber - 1] != null,
		);
		const ensurePageProxy = usePdf((state) => state.ensurePageProxy);
		const viewport = usePdf((state) => state.viewports[pageNumber - 1]);

		useEffect(() => {
			if (!hasProxy) {
				ensurePageProxy(pageNumber);
			}
		}, [hasProxy, ensurePageProxy, pageNumber]);

		const width = viewport?.width ?? 612;
		const height = viewport?.height ?? 792;

		if (!hasProxy) {
			return (
				<Primitive.div style={{ display: "block" }}>
					<div
						style={
							{
								"--scale-factor": 1,
								"--total-scale-factor": 1,
								backgroundColor: "white",
								position: "relative",
								width,
								height,
								...style,
							} as CSSProperties
						}
						{...props}
					/>
				</Primitive.div>
			);
		}

		return <LoadedPage pageNumber={pageNumber} style={style} {...props}>{children}</LoadedPage>;
	},
);

Page.displayName = "Page";

const LoadedPage = memo(
	({
		children,
		pageNumber,
		style,
		...props
	}: HTMLProps<HTMLDivElement> & {
		children: ReactNode;
		pageNumber: number;
	}) => {
		const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
		const viewport = usePdf((state) => state.viewports[pageNumber - 1]);

		const width =
			viewport?.width ??
			(pdfPageProxy.view[2] ?? 0) - (pdfPageProxy.view[0] ?? 0);
		const height =
			viewport?.height ??
			(pdfPageProxy.view[3] ?? 0) - (pdfPageProxy.view[1] ?? 0);

		return (
			<PDFPageNumberContext.Provider value={pdfPageProxy.pageNumber}>
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
								backgroundColor: "white",
								position: "relative",
								width,
								height,
								...style,
							} as CSSProperties
						}
						{...props}
					>
						{children}
					</div>
				</Primitive.div>
			</PDFPageNumberContext.Provider>
		);
	},
);

LoadedPage.displayName = "LoadedPage";
