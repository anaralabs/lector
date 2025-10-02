import { cloneElement, type HTMLProps, type ReactElement } from "react";

import { usePdfJump } from "../hooks/pages/usePdfJump";
import { useThumbnail } from "../hooks/useThumbnail";
import { usePdf } from "../internal";
import { Primitive } from "./primitive";

export const Thumbnail = ({
	pageNumber = 1,
	...props
}: HTMLProps<HTMLCanvasElement> & { pageNumber?: number }) => {
	const { canvasRef, containerRef, isVisible } = useThumbnail(pageNumber, {
		isFirstPage: pageNumber < 5,
	});
	const { jumpToPage } = usePdfJump();

	return (
		<div ref={containerRef} style={{ minHeight: "150px", minWidth: "10px" }}>
			{isVisible && (
				<Primitive.canvas
					{...props}
					role="button"
					tabIndex={0}
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					onClick={(e: any) => {
						if (props.onClick) {
							props.onClick(e);
						}

						jumpToPage(pageNumber, { behavior: "auto" });
					}}
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					onKeyDown={(e: any) => {
						if (props.onKeyDown) {
							props.onKeyDown(e);
						}

						if (e.key === "Enter") {
							jumpToPage(pageNumber, { behavior: "auto" });
						}
					}}
					ref={canvasRef}
				/>
			)}
		</div>
	);
};

export const Thumbnails = ({
	children,
	...props
}: HTMLProps<HTMLDivElement> & {
	children: ReactElement<typeof Thumbnail>;
}) => {
	const pageCount = usePdf((state) => state.pdfDocumentProxy.numPages);

	return (
		<Primitive.div {...props}>
			{Array.from({
				length: pageCount,
			}).map((_, index) => {
				//@ts-expect-error pageNumber is not a valid react key
				// biome-ignore lint/suspicious/noArrayIndexKey: <index for now>
				return cloneElement(children, { key: index, pageNumber: index + 1 });
			})}
		</Primitive.div>
	);
};
