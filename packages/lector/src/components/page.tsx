import type { HTMLProps, ReactNode } from "react";

import { PDFPageNumberContext } from "../hooks/usePdfPageNumber";
import { usePdf } from "../internal";
import { Primitive } from "./primitive";

export const Page = ({
	children,
	pageNumber = 1,
	style,
	...props
}: HTMLProps<HTMLDivElement> & {
	children: ReactNode;
	pageNumber?: number;
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
							...style,
							"--scale-factor": 1,
							"--total-scale-factor": 1,
							position: "relative",
							width,
							height,
						} as React.CSSProperties
					}
					{...props}
				>
					{children}
				</div>
			</Primitive.div>
		</PDFPageNumberContext.Provider>
	);
};
