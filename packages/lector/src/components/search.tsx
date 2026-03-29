import { useCallback, useEffect, useState } from "react";

import { usePdf } from "../internal";
import { getTextLayerPageModel } from "../lib/text-layer/model";

interface SearchProps {
	children: React.ReactNode;
	loading?: React.ReactNode;
}

export const Search = ({ children, loading = "Loading..." }: SearchProps) => {
	const [isLoading, setIsLoading] = useState(false);

	const proxies = usePdf((state) => state.pageProxies);
	const setTextContent = usePdf((state) => state.setTextContent);

	const getTextContent = useCallback(async () => {
		setIsLoading(true);
		const promises = proxies.map(async (proxy) => {
			const model = await getTextLayerPageModel(proxy);

			return {
				pageNumber: proxy.pageNumber,
				text: model.text,
			};
		});
		const text = await Promise.all(promises);

		setIsLoading(false);
		setTextContent(text);
	}, [proxies, setTextContent]);

	useEffect(() => {
		getTextContent();
	}, [getTextContent]);

	return isLoading ? loading : children;
};
