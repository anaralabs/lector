import { useEffect, useState } from "react";
import { usePdf } from "../internal";
import { acquireDocumentText } from "../lib/document-text";

interface SearchProps {
	children: React.ReactNode;
	loading?: React.ReactNode;
}

export const Search = ({ children, loading = "Loading..." }: SearchProps) => {
	const [isLoading, setIsLoading] = useState(true);
	const proxies = usePdf((state) => state.pageProxies);
	const setTextContent = usePdf((state) => state.setTextContent);

	useEffect(() => {
		let disposed = false;
		setIsLoading(true);
		const task = acquireDocumentText(proxies);
		void task.promise
			.then((text) => {
				if (disposed) return;
				setTextContent(text);
				setIsLoading(false);
			})
			.catch((error) => {
				if (disposed) return;
				console.error("Error extracting PDF text", error);
				setIsLoading(false);
			});
		return () => {
			disposed = true;
			task.release();
		};
	}, [proxies, setTextContent]);

	return isLoading ? loading : children;
};
