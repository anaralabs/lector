"use client";

import { usePdf, usePdfJump } from "@anaralabs/lector";
import { useEffect, useState } from "react";
import { Button } from "./button";

const PageNavigationButtons = () => {
	const pages = usePdf((state) => state.pdfDocumentProxy?.numPages);
	const currentPage = usePdf((state) => state.currentPage);
	const [pageNumber, setPageNumber] = useState<string | number>(currentPage);
	const { jumpToPage } = usePdfJump();

	const handlePreviousPage = () => {
		if (currentPage > 1) {
			jumpToPage(currentPage - 1, { behavior: "auto" });
		}
	};

	const handleNextPage = () => {
		if (currentPage < pages) {
			jumpToPage(currentPage + 1, { behavior: "auto" });
		}
	};

	useEffect(() => {
		setPageNumber(currentPage);
	}, [currentPage]);

	return (
		<div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 flex items-center gap-3 bg-white/90 backdrop-blur-sm rounded-full shadow-lg px-4 py-2.5 border border-gray-200 pointer-events-auto z-50">
			<Button
				variant={"ghost"}
				onClick={handlePreviousPage}
				disabled={currentPage <= 1}
				className="rounded-full disabled:opacity-40 disabled:cursor-not-allowed"
				aria-label="Previous page"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="text-gray-600"
				>
					<path d="m15 18-6-6 6-6" />
				</svg>
			</Button>

			<div className="flex items-center gap-2">
				<input
					type="number"
					value={pageNumber}
					onChange={(e) => setPageNumber(e.target.value)}
					onBlur={(e) => {
						const value = Number(e.target.value);
						if (value >= 1 && value <= pages && currentPage !== value) {
							jumpToPage(value, { behavior: "auto" });
						} else {
							setPageNumber(currentPage);
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.currentTarget.blur();
						}
					}}
					className="w-12 h-7 text-center bg-gray-50 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
				/>
				<span className="text-sm text-gray-500 font-medium min-w-[40px]">
					/ {pages || 1}
				</span>
			</div>

			<Button
				onClick={handleNextPage}
				disabled={currentPage >= pages}
				variant={"ghost"}
				className="rounded-full disabled:opacity-40 disabled:cursor-not-allowed"
				aria-label="Next page"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="text-gray-600"
				>
					<path d="m9 18 6-6-6-6" />
				</svg>
			</Button>
		</div>
	);
};

export default PageNavigationButtons;
