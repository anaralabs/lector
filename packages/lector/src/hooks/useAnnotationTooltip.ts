import {
	autoUpdate,
	flip,
	inline,
	offset,
	shift,
	useDismiss,
	useFloating,
	useInteractions,
} from "@floating-ui/react";
import { useCallback, useEffect, useState } from "react";

import { usePdf } from "../internal";
import type { Annotation } from "./useAnnotations";

interface UseAnnotationTooltipProps {
	annotation: Annotation;
	onOpenChange?: (open: boolean) => void;
	position?: "top" | "bottom" | "left" | "right";
	isOpen?: boolean;
}

interface UseAnnotationTooltipReturn {
	isOpen: boolean;
	setIsOpen: (open: boolean) => void;
	refs: ReturnType<typeof useFloating>["refs"];
	floatingStyles: ReturnType<typeof useFloating>["floatingStyles"];
	getFloatingProps: ReturnType<typeof useInteractions>["getFloatingProps"];
	getReferenceProps: ReturnType<typeof useInteractions>["getReferenceProps"];
}

export const useAnnotationTooltip = ({
	annotation,
	onOpenChange,
	position = "top",
	isOpen: controlledIsOpen,
}: UseAnnotationTooltipProps): UseAnnotationTooltipReturn => {
	// Show tooltip immediately if it's a new annotation
	const isNewAnnotation =
		Date.now() - new Date(annotation.createdAt).getTime() < 1000;
	const [isPositionCalculated, setIsPositionCalculated] = useState(false);
	const [isOpen, setIsOpen] = useState(false);
	const viewportRef = usePdf((state) => state.viewportRef);
	const scale = usePdf((state) => state.zoom);

	// Only show if position is calculated or externally controlled
	const effectiveIsOpen =
		((isOpen && isPositionCalculated) || controlledIsOpen) ?? false;

	const { refs, floatingStyles, context } = useFloating({
		placement: position,
		open: effectiveIsOpen,
		onOpenChange: (open) => {
			setIsOpen(open);
			onOpenChange?.(open);
		},
		whileElementsMounted: autoUpdate,
		middleware: [
			inline(),
			offset(10),
			flip({
				crossAxis: false,
				fallbackAxisSideDirection: "end",
			}),
			shift({ padding: 8 }),
		],
	});

	const dismiss = useDismiss(context);
	const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

	const updateTooltipPosition = useCallback(() => {
		if (!annotation.highlights.length) {
			setIsPositionCalculated(false);
			return;
		}

		const highlightRects = annotation.highlights;
		let minLeft = Infinity;
		let maxRight = -Infinity;
		let minTop = Infinity;
		let maxBottom = -Infinity;

		const viewportElement = viewportRef.current;
		if (!viewportElement) {
			setIsPositionCalculated(false);
			return;
		}

		const pageElement = viewportElement.querySelector(
			`[data-page-number="${annotation.pageNumber}"]`,
		);
		if (!pageElement) {
			setIsPositionCalculated(false);
			return;
		}

		refs.setReference({
			getBoundingClientRect() {
				const pageRect = pageElement.getBoundingClientRect();

				// Calculate the bounding box in viewport coordinates using the PDF scale
				highlightRects.forEach((highlight) => {
					const scaledLeft = highlight.left * scale;
					const scaledWidth = highlight.width * scale;
					const scaledTop = highlight.top * scale;
					const scaledHeight = highlight.height * scale;

					const left = pageRect.left + scaledLeft;
					const right = left + scaledWidth;
					const top = pageRect.top + scaledTop;
					const bottom = top + scaledHeight;

					minLeft = Math.min(minLeft, left);
					maxRight = Math.max(maxRight, right);
					minTop = Math.min(minTop, top);
					maxBottom = Math.max(maxBottom, bottom);
				});

				const width = maxRight - minLeft;
				const height = maxBottom - minTop;
				const centerX = minLeft + width / 2;
				const centerY = minTop + height / 2;

				const rect = {
					width,
					height,
					x: centerX - width / 2,
					y: centerY - height / 2,
					top: centerY - height / 2,
					right: centerX + width / 2,
					bottom: centerY + height / 2,
					left: centerX - width / 2,
				};

				return rect;
			},
			getClientRects() {
				return [this.getBoundingClientRect()];
			},
			contextElement: viewportRef.current || undefined,
		});

		setIsPositionCalculated(true);

		// If it's a new annotation, show it once position is calculated
		if (isNewAnnotation) {
			setIsOpen(true);
		}
	}, [
		annotation.highlights,
		annotation.pageNumber,
		refs,
		viewportRef,
		scale,
		isNewAnnotation,
	]);

	useEffect(() => {
		const viewport = viewportRef.current;

		// Reset position calculated state when scale changes
		setIsPositionCalculated(false);

		// Update position with RAF to ensure DOM is ready
		requestAnimationFrame(() => {
			updateTooltipPosition();
		});

		const handleScroll = () => {
			requestAnimationFrame(updateTooltipPosition);
		};

		const handleResize = () => {
			requestAnimationFrame(updateTooltipPosition);
		};

		if (viewport) {
			viewport.addEventListener("scroll", handleScroll, {
				passive: true,
			});
		}

		window.addEventListener("resize", handleResize, { passive: true });

		return () => {
			if (viewport) {
				viewport.removeEventListener("scroll", handleScroll);
			}
			window.removeEventListener("resize", handleResize);
		};
	}, [updateTooltipPosition, viewportRef]);

	return {
		isOpen: effectiveIsOpen,
		setIsOpen,
		refs,
		floatingStyles,
		getFloatingProps,
		getReferenceProps,
	};
};
