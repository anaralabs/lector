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
import { PDFStore, usePdf } from "../internal";
import type { ColorScheme, DarkModeColors } from "../lib/dark-mode";
import { Primitive } from "./primitive";

/**
 * Mirrors post-mount changes of Root's colorScheme/darkModeColors props into
 * the store (the Provider's initialValue is frozen at mount). No-ops when the
 * consumer drives the scheme through `setColorScheme` instead of props.
 */
const ColorSchemeSync = ({
	colorScheme,
	darkModeColors,
}: {
	colorScheme?: ColorScheme;
	darkModeColors?: DarkModeColors;
}) => {
	const setColorScheme = usePdf((state) => state.setColorScheme);
	const background = darkModeColors?.background;
	const foreground = darkModeColors?.foreground;
	useEffect(() => {
		if (!colorScheme) return;
		setColorScheme(colorScheme, { background, foreground });
	}, [colorScheme, background, foreground, setColorScheme]);
	return null;
};

export const Root = forwardRef(
	(
		{
			children,
			source,
			loader,
			onDocumentLoad,
			onError,
			isZoomFitWidth,
			zoom,
			zoomOptions,
			documentOptions,
			colorScheme,
			darkModeColors,
			...props
		}: Omit<HTMLProps<HTMLDivElement>, "onError"> &
			usePDFDocumentParams & {
				loader?: ReactNode;
			},
		ref,
	) => {
		const { initialState } = usePDFDocumentContext({
			source,
			onDocumentLoad,
			onError,
			isZoomFitWidth,
			zoom,
			zoomOptions,
			documentOptions,
			colorScheme,
			darkModeColors,
		});

		const linkService = useCreatePDFLinkService(
			initialState?.pdfDocumentProxy ?? null,
		);

		const documentId = initialState?.pdfDocumentProxy?.fingerprints?.[0];
		useEffect(() => {
			if (!documentId) return;
			return () => {
				clearBitmapCache(documentId);
			};
		}, [documentId]);

		return (
			<Primitive.div ref={ref} {...props}>
				{initialState ? (
					<PDFStore.Provider initialValue={initialState}>
						<ColorSchemeSync
							colorScheme={colorScheme}
							darkModeColors={darkModeColors}
						/>
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
