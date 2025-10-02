import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Annotation } from "../hooks/useAnnotations";
import { useAnnotationTooltip } from "../hooks/useAnnotationTooltip";
import { usePdf } from "../internal";

export type AnnotationTooltipContentProps = {
	annotation: Annotation;
	onClose: () => void;
	setPosition?: (position: "top" | "bottom" | undefined) => void;
};

interface AnnotationTooltipProps {
	annotation: Annotation;
	children: React.ReactNode;
	renderTooltipContent: (
		props: AnnotationTooltipContentProps,
	) => React.ReactNode;
	hoverTooltipContent?: React.ReactNode;
	onOpenChange?: (open: boolean) => void;
	isOpen?: boolean;
	focusedOpenId?: string;
	focusedHoverOpenId?: string;
	className?: string;
	hoverClassName?: string;
	hoverIsOpen?: boolean;
	renderHoverTooltipContent?: (props: {
		annotation: Annotation;
		onClose: () => void;
	}) => React.ReactNode;
}

export const AnnotationTooltip = ({
	annotation,
	children,
	renderTooltipContent,
	hoverTooltipContent,
	onOpenChange,
	className,
	focusedOpenId,
	focusedHoverOpenId,
	hoverClassName,
	isOpen: controlledIsOpen,
	hoverIsOpen: controlledHoverIsOpen,
}: AnnotationTooltipProps) => {
	const viewportRef = usePdf((state) => state.viewportRef);
	const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const isMouseInTooltipRef = useRef(false);
	const [triggeredPosition, setTriggeredPosition] = useState<
		"top" | "bottom" | undefined
	>();

	const {
		isOpen: uncontrolledIsOpen,
		setIsOpen,
		refs,
		floatingStyles,
		getFloatingProps,
		getReferenceProps,
	} = useAnnotationTooltip({
		annotation,
		onOpenChange,
		position: triggeredPosition,
		isOpen: controlledIsOpen,
	});

	const {
		isOpen: uncontrolledHoverIsOpen,
		setIsOpen: setHoverIsOpen,
		refs: hoverRefs,

		floatingStyles: hoverFloatingStyles,
		getFloatingProps: getHoverFloatingProps,
		getReferenceProps: getHoverReferenceProps,
	} = useAnnotationTooltip({
		position: "bottom",
		annotation,
		isOpen: controlledHoverIsOpen,
	});

	const isOpen = controlledIsOpen ?? uncontrolledIsOpen;
	const hoverIsOpen = controlledHoverIsOpen || uncontrolledHoverIsOpen;

	const handleClick = useCallback(() => {
		if (controlledIsOpen === undefined) {
			setIsOpen(!isOpen);
		}
	}, [controlledIsOpen, isOpen, setIsOpen]);

	const handleMouseEnter = useCallback(() => {
		if (focusedOpenId && focusedOpenId !== annotation.id) return;
		if (focusedHoverOpenId && focusedHoverOpenId !== annotation.id) return;

		if (hoverTooltipContent) {
			if (closeTimeoutRef.current) {
				clearTimeout(closeTimeoutRef.current);
				closeTimeoutRef.current = null;
			}
			setHoverIsOpen(true);
		}
	}, [
		hoverTooltipContent,
		setHoverIsOpen,
		annotation.id,
		focusedHoverOpenId,
		focusedOpenId,
	]);

	const closeTooltip = useCallback(() => {
		if (!isMouseInTooltipRef.current) {
			setHoverIsOpen(false);
		}
	}, [setHoverIsOpen]);

	const handleMouseLeave = useCallback(() => {
		if (!hoverTooltipContent) return;

		// Set a timeout to close the tooltip, giving time to move to it
		closeTimeoutRef.current = setTimeout(closeTooltip, 100);
	}, [hoverTooltipContent, closeTooltip]);

	const handleTooltipMouseEnter = useCallback(() => {
		if (focusedOpenId && focusedOpenId !== annotation.id) return;
		if (focusedHoverOpenId && focusedHoverOpenId !== annotation.id) return;

		isMouseInTooltipRef.current = true;
		if (closeTimeoutRef.current) {
			clearTimeout(closeTimeoutRef.current);
			closeTimeoutRef.current = null;
		}
	}, [annotation.id, focusedOpenId, focusedHoverOpenId]);

	const handleTooltipMouseLeave = useCallback(() => {
		isMouseInTooltipRef.current = false;
		setHoverIsOpen(false);
	}, [setHoverIsOpen]);

	return (
		<>
			<div
				ref={(node) => {
					refs.setReference(node);
					hoverRefs.setReference(node);
				}}
				onClick={handleClick}
				onMouseEnter={handleMouseEnter}
				onMouseLeave={handleMouseLeave}
				{...getReferenceProps()}
				{...getHoverReferenceProps()}
			>
				{children}
			</div>
			{/* Click tooltip */}
			{isOpen &&
				viewportRef.current &&
				createPortal(
					<div
						ref={refs.setFloating}
						className={className}
						data-annotation-tooltip="click"
						style={{
							...floatingStyles,
							position: "absolute",
							pointerEvents: "auto",
							zIndex: 50,
						}}
						{...getFloatingProps()}
					>
						{renderTooltipContent({
							annotation,
							onClose: () => setIsOpen(false),
							setPosition: (position: "top" | "bottom" | undefined) =>
								setTriggeredPosition(position),
						})}
					</div>,
					viewportRef.current,
				)}
			{/* Hover tooltip */}
			{!isOpen &&
				hoverIsOpen &&
				annotation.comment &&
				hoverTooltipContent &&
				viewportRef.current &&
				createPortal(
					<div
						ref={hoverRefs.setFloating}
						className={hoverClassName}
						data-annotation-tooltip="hover"
						style={{
							...hoverFloatingStyles,
							position: "absolute",
							pointerEvents: "auto",
							zIndex: 51,
						}}
						onMouseEnter={handleTooltipMouseEnter}
						onMouseLeave={handleTooltipMouseLeave}
						{...getHoverFloatingProps()}
					>
						{hoverTooltipContent}
					</div>,
					viewportRef.current,
				)}
		</>
	);
};
