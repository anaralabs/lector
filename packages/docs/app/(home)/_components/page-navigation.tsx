import { usePdf, usePdfJump } from "@anaralabs/lector";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export const PageNavigation = () => {
	const pages = usePdf((state) => state.pdfDocumentProxy.numPages);
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
		<div className="absolute flex flex-row items-center justify-center top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 gap-1">
			<Button
				variant="ghost"
				size="icon"
				onClick={handlePreviousPage}
				disabled={currentPage <= 1}
				aria-label="Previous page"
				className="h-8 w-8"
			>
				<Icon as={ChevronLeft} className="h-4 w-4" />
			</Button>

			<div className="flex items-center gap-1">
				<input
					type="number"
					value={pageNumber}
					onChange={(e) => setPageNumber(e.target.value)}
					onBlur={(e) => {
						if (currentPage !== Number(e.target.value)) {
							jumpToPage(Number(e.target.value), {
								behavior: "auto",
							});
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.currentTarget.blur();
						}
					}}
					className="[appearance:textfield] w-10 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none text-center bg-accent border-none text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 rounded-md"
				/>
				<span className="text-sm text-muted-foreground font-medium">
					/ {pages}
				</span>
			</div>
			<Button
				variant="ghost"
				size="icon"
				onClick={handleNextPage}
				disabled={currentPage >= pages}
				aria-label="Next page"
				className="h-8 w-8"
			>
				<Icon as={ChevronRight} className="h-4 w-4" />
			</Button>
		</div>
	);
};
