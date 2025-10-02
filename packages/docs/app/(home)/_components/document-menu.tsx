import { usePdf } from "@anaralabs/lector";
import { DownloadCloud, Ellipsis, Link } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";

interface DocumentMenuProps {
	documentUrl: string;
}

const DocumentMenu = ({ documentUrl }: DocumentMenuProps) => {
	const [isDownloading, setIsDownloading] = useState(false);
	const pdfDocumentProxy = usePdf((state) => state.pdfDocumentProxy);

	const handleDownload = async () => {
		if (!pdfDocumentProxy || isDownloading) return;

		try {
			setIsDownloading(true);

			// Get the PDF data
			const pdfData = await pdfDocumentProxy.getData();
			const blob = new Blob([pdfData], { type: "application/pdf" });

			// Create download link
			const url = window.URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;

			// Extract filename from URL or use default
			const filename = documentUrl.split("/").pop() || "document.pdf";
			link.download = filename;

			// Trigger download
			document.body.appendChild(link);
			link.click();

			// Cleanup
			document.body.removeChild(link);
			window.URL.revokeObjectURL(url);
		} catch (error) {
			console.error("Error downloading PDF:", error);
			// You might want to add proper error handling/notification here
		} finally {
			setIsDownloading(false);
		}
	};

	const handleOpenClick = () => {
		window.open(documentUrl, "_blank");
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" className="h-9 w-9" size="icon">
					<Icon as={Ellipsis} />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-40">
				<DropdownMenuItem
					onClick={handleDownload}
					disabled={isDownloading || !pdfDocumentProxy}
				>
					<Icon as={DownloadCloud} />
					{isDownloading ? "Downloading..." : "Download"}
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleOpenClick}>
					<Icon as={Link} /> Open
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};

export default DocumentMenu;
