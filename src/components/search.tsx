import type { PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { useCallback, useEffect, useState } from "react";

import { usePdf } from "../internal";

interface SearchProps {
	children: React.ReactNode;
	loading?: React.ReactNode;
}

export const Search = ({ children, loading = "Loading..." }: SearchProps) => {
	const [isLoading, setIsLoading] = useState(false);

	const proxies = usePdf((state) => state.pageProxies);
	const setTextContent = usePdf((state) => state.setTextContent);

	const getTextContent = useCallback(
		async (pages: PDFPageProxy[]) => {
			setIsLoading(true);
			const promises = pages.map(async (proxy) => {
				const content = await proxy.getTextContent();
				const text = content.items
					.map((item) => (item as TextItem)?.str || "")
					.join("");

				return Promise.resolve({
					pageNumber: proxy.pageNumber,
					text,
				});
			});
			const text = await Promise.all(promises);

			setIsLoading(false);
			setTextContent(text);
		},
		[setTextContent],
	);

	useEffect(() => {
		getTextContent(proxies);
	}, [proxies, getTextContent]);

	return isLoading ? loading : children;
};
