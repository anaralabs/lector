import { type RefObject, useEffect, useState } from "react";

export const useVisibility = ({
	elementRef,
}: {
	elementRef: RefObject<HTMLElement | null>;
}) => {
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		if (!elementRef.current) {
			return;
		}

		const observer = new IntersectionObserver(([entry]) => {
			setVisible(entry?.isIntersecting ?? false);
		});

		observer.observe(elementRef.current);

		return () => {
			observer.disconnect();
		};
	}, [elementRef]);

	return { visible };
};
