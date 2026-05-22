import {
	cloneElement,
	type HTMLProps,
	memo,
	type ReactElement,
	useEffect,
	useRef,
} from "react";

import { useFitWidth } from "../hooks/pages/useFitWidth";
import { useViewportContainer } from "../hooks/viewport/useViewportContainer";
import { usePdf } from "../internal";
import { Primitive } from "./primitive";

const selectLargestPageWidth = (state: {
	viewports: Array<{ width: number }>;
}) => state.viewports.reduce((max, vp) => Math.max(max, vp.width), 0);

interface FlatPageItemProps {
	child: ReactElement;
	index: number;
	innerBoxWidth: number;
	innerBoxHeight: number;
	gap: number;
}

const FlatPageItem = memo(
	({ child, index, innerBoxWidth, innerBoxHeight, gap }: FlatPageItemProps) => {
		return (
			<div
				style={{
					width: innerBoxWidth,
					height: innerBoxHeight,
					marginBottom: gap,
				}}
			>
				{cloneElement(child, {
					key: index,
					// @ts-expect-error pageNumber is not on the generic child element type
					pageNumber: index + 1,
				})}
			</div>
		);
	},
);

FlatPageItem.displayName = "FlatPageItem";

export const Pages = ({
	children,
	gap = 10,
	// kept for API compatibility — ignored in this experiment
	virtualizerOptions: _virtualizerOptions,
	initialOffset,
	onOffsetChange,
	...props
}: HTMLProps<HTMLDivElement> & {
	virtualizerOptions?: {
		overscan?: number;
	};
	gap?: number;
	children: ReactElement;
	initialOffset?: number;
	onOffsetChange?: (offset: number) => void;
}) => {
	const viewports = usePdf((state) => state.viewports);
	const numPages = usePdf((state) => state.pdfDocumentProxy.numPages);

	const elementWrapperRef = useRef<HTMLDivElement>(null);
	const elementRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	useViewportContainer({
		elementRef: elementRef,
		elementWrapperRef: elementWrapperRef,
		containerRef,
	});

	useFitWidth({ viewportRef: containerRef });
	const largestPageWidth = usePdf(selectLargestPageWidth);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || initialOffset == null) return;
		container.scrollTop = initialOffset;
	}, [initialOffset]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || !onOffsetChange) return;
		const handler = () => onOffsetChange(container.scrollTop);
		container.addEventListener("scroll", handler, { passive: true });
		return () => container.removeEventListener("scroll", handler);
	}, [onOffsetChange]);

	return (
		<Primitive.div
			ref={containerRef}
			{...props}
			style={{
				display: "flex",
				justifyContent: "center",
				height: "100%",
				position: "relative",
				overflow: "auto",
				...props.style,
			}}
		>
			<div
				ref={elementWrapperRef}
				style={{
					width: "max-content",
				}}
			>
				<div
					ref={elementRef}
					style={{
						display: "flex",
						alignItems: "center",
						flexDirection: "column",
						transformOrigin: "0 0",
						willChange: "transform",
						width: largestPageWidth,
						margin: "0 auto",
					}}
				>
					{Array.from({ length: numPages || 0 }, (_, index) => {
						const vp = viewports?.[index];
						const innerBoxWidth = vp?.width ?? 0;
						const innerBoxHeight = vp?.height ?? 0;

						if (!innerBoxWidth) return null;

						return (
							<FlatPageItem
								key={index}
								child={children}
								index={index}
								innerBoxWidth={innerBoxWidth}
								innerBoxHeight={innerBoxHeight}
								gap={gap}
							/>
						);
					})}
				</div>
			</div>
		</Primitive.div>
	);
};
