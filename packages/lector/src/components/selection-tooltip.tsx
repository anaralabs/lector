import {
	autoUpdate,
	offset,
	shift,
	useDismiss,
	useFloating,
	useInteractions,
} from "@floating-ui/react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { usePdf } from "../internal";

interface SelectionTooltipProps {
	children: React.ReactNode;
}

export const SelectionTooltip = ({ children }: SelectionTooltipProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const lastSelectionRef = useRef<Range | null>(null);
	const viewportRef = usePdf((state) => state.viewportRef);

	const { refs, floatingStyles, context } = useFloating({
		placement: "bottom",
		open: isOpen,
		onOpenChange: setIsOpen,
		whileElementsMounted: autoUpdate,
		middleware: [offset(10), shift({ padding: 8 })],
	});

	const dismiss = useDismiss(context);
	const { getFloatingProps } = useInteractions([dismiss]);

	// Function to update tooltip position based on selection
	const updateTooltipPosition = useCallback(() => {
		const selection = document.getSelection();

		if (!selection || selection.isCollapsed) {
			setIsOpen(false);
			lastSelectionRef.current = null;
			return;
		}

		const range = selection.getRangeAt(0);
		if (!range) return;

		const rects = range.getClientRects();
		const lastRect = rects[rects.length - 1];

		lastSelectionRef.current = range;
		if (lastRect) {
			refs.setReference({
				getBoundingClientRect: () => ({
					width: lastRect.width,
					height: lastRect.height,
					x: lastRect.left,
					y: lastRect.bottom, // Position below the last line of selection
					top: lastRect.bottom,
					right: lastRect.right,
					bottom: lastRect.bottom + lastRect.height,
					left: lastRect.left,
				}),
				getClientRects: () => [lastRect],
			});
			setIsOpen(true);
		} else {
			setIsOpen(false);
		}
	}, [refs]);

	useEffect(() => {
		const handleSelectionChange = () => {
			const selection = document.getSelection();

			// Check if selection is within the viewport and not within a tooltip
			if (selection && viewportRef.current?.contains(selection.anchorNode)) {
				// Check if the selection is within a tooltip
				const anchorNode = selection.anchorNode;
				const focusNode = selection.focusNode;

				const isInUnselectableArea = (node: Node | null): boolean => {
					if (!node) return false;

					let element =
						node.nodeType === Node.ELEMENT_NODE
							? (node as Element)
							: node.parentElement;

					while (element) {
						// Check for our custom tooltip attributes
						if (element.getAttribute("data-annotation-tooltip")) {
							return true;
						}

						// Check for floating UI portal
						if (element.hasAttribute("data-floating-ui-portal")) {
							return true;
						}

						element = element.parentElement;
					}
					return false;
				};

				// Only show selection tooltip if selection is not in an unselectable area
				if (
					!isInUnselectableArea(anchorNode) &&
					!isInUnselectableArea(focusNode)
				) {
					requestAnimationFrame(updateTooltipPosition);
				} else {
					setIsOpen(false);
				}
			} else {
				setIsOpen(false);
			}
		};

		const handleScroll = () => {
			if (!isOpen || !lastSelectionRef.current) return;
			requestAnimationFrame(updateTooltipPosition);
		};

		// Add selection change listener to document (since it can't be added directly to elements)
		document.addEventListener("selectionchange", handleSelectionChange);

		if (viewportRef.current) {
			viewportRef.current.addEventListener("scroll", handleScroll, {
				passive: true,
			});
		}

		return () => {
			document.removeEventListener("selectionchange", handleSelectionChange);
			if (viewportRef.current) {
				// eslint-disable-next-line react-hooks/exhaustive-deps
				viewportRef.current.removeEventListener("scroll", handleScroll);
			}
		};
	}, [isOpen, viewportRef, updateTooltipPosition]);

	// Handle clicks on the floating tooltip
	useEffect(() => {
		const handleFloatingClick = (e: MouseEvent) => {
			if (refs.floating.current?.contains(e.target as Node)) {
				e.stopPropagation();
			}
		};

		document.addEventListener("click", handleFloatingClick);
		return () => document.removeEventListener("click", handleFloatingClick);
	}, [refs.floating]);

	return (
		<>
			{isOpen && (
				<div
					ref={refs.setFloating}
					style={{
						...floatingStyles,
					}}
					{...getFloatingProps()}
				>
					{children}
				</div>
			)}
		</>
	);
};
