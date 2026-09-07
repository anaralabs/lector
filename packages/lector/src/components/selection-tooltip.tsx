import {
	autoUpdate,
	flip,
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
	const isPointerDownRef = useRef(false);
	const viewportRef = usePdf((state) => state.viewportRef);

	const { refs, floatingStyles, context } = useFloating({
		placement: "bottom",
		open: isOpen,
		onOpenChange: setIsOpen,
		whileElementsMounted: autoUpdate,
		middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8 })],
	});

	const dismiss = useDismiss(context);
	const { getFloatingProps } = useInteractions([dismiss]);

	const updateTooltipPosition = useCallback(() => {
		if (isPointerDownRef.current) {
			setIsOpen(false);
			return;
		}
		const selection = document.getSelection();

		if (!selection || selection.isCollapsed) {
			setIsOpen(false);
			lastSelectionRef.current = null;
			return;
		}

		const range = selection.getRangeAt(0);
		if (!range) return;

		const rects = range.getClientRects();
		const firstRect = rects[0];
		const lastRect = rects[rects.length - 1];

		lastSelectionRef.current = range;
		if (firstRect && lastRect) {
			refs.setReference({
				getBoundingClientRect: () => ({
					width: lastRect.width,
					height: lastRect.bottom - firstRect.top,
					x: lastRect.left,
					y: firstRect.top,
					top: firstRect.top,
					right: lastRect.right,
					bottom: lastRect.bottom,
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
		const handlePointerDown = (event: PointerEvent) => {
			if (
				event.button === 0 &&
				viewportRef.current?.contains(event.target as Node) &&
				!refs.floating.current?.contains(event.target as Node)
			) {
				isPointerDownRef.current = true;
			}
		};
		const handlePointerUp = () => {
			if (!isPointerDownRef.current) return;
			isPointerDownRef.current = false;
			requestAnimationFrame(updateTooltipPosition);
		};
		document.addEventListener("pointerdown", handlePointerDown, true);
		document.addEventListener("pointerup", handlePointerUp, true);
		document.addEventListener("pointercancel", handlePointerUp, true);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown, true);
			document.removeEventListener("pointerup", handlePointerUp, true);
			document.removeEventListener("pointercancel", handlePointerUp, true);
		};
	}, [updateTooltipPosition, viewportRef, refs.floating]);

	useEffect(() => {
		const handleSelectionChange = () => {
			const selection = document.getSelection();

			if (selection && viewportRef.current?.contains(selection.anchorNode)) {
				const anchorNode = selection.anchorNode;
				const focusNode = selection.focusNode;

				const isInUnselectableArea = (node: Node | null): boolean => {
					if (!node) return false;

					let element =
						node.nodeType === Node.ELEMENT_NODE
							? (node as Element)
							: node.parentElement;

					while (element) {
						if (element.getAttribute("data-annotation-tooltip")) {
							return true;
						}

						if (element.hasAttribute("data-floating-ui-portal")) {
							return true;
						}

						element = element.parentElement;
					}
					return false;
				};

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

		document.addEventListener("selectionchange", handleSelectionChange);

		if (viewportRef.current) {
			viewportRef.current.addEventListener("scroll", handleScroll, {
				passive: true,
			});
		}

		return () => {
			document.removeEventListener("selectionchange", handleSelectionChange);
			if (viewportRef.current) {
				viewportRef.current.removeEventListener("scroll", handleScroll);
			}
		};
	}, [isOpen, viewportRef, updateTooltipPosition]);

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
