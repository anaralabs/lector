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
import {
	type ColorScheme,
	type DarkModeColors,
	DEFAULT_DARK_MODE_COLORS,
} from "../lib/dark-mode";
import { Primitive } from "./primitive";

/**
 * Mirrors post-mount changes of Root's colorScheme/darkModeColors props into
 * the store (the Provider's initialValue is frozen at mount). No-ops when the
 * consumer drives everything through `setColorScheme` instead of props.
 *
 * Palette contract: when the `darkModeColors` prop is provided the store
 * mirrors it exactly — fields it omits resolve to the defaults — even when
 * the scheme itself is driven at runtime (no colorScheme prop). When the
 * prop is absent the palette is uncontrolled: scheme prop flips leave
 * whatever palette runtime `setColorScheme` calls have established.
 */
const ColorSchemeSync = ({
	colorScheme,
	darkModeColors,
}: {
	colorScheme?: ColorScheme;
	darkModeColors?: DarkModeColors;
}) => {
	const setColorScheme = usePdf((state) => state.setColorScheme);
	const storeColorScheme = usePdf((state) => state.colorScheme);
	const hasPalette = darkModeColors !== undefined;
	const background = darkModeColors?.background;
	const foreground = darkModeColors?.foreground;
	useEffect(() => {
		if (!colorScheme && !hasPalette) return;
		// Without a colorScheme prop, a provided palette still syncs — against
		// the store's current scheme, so it composes with runtime toggles.
		setColorScheme(
			colorScheme ?? storeColorScheme,
			hasPalette
				? {
						background: background ?? DEFAULT_DARK_MODE_COLORS.background,
						foreground: foreground ?? DEFAULT_DARK_MODE_COLORS.foreground,
					}
				: undefined,
		);
	}, [
		colorScheme,
		storeColorScheme,
		hasPalette,
		background,
		foreground,
		setColorScheme,
	]);
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
