import { useEffect, useState } from "react";

export const useDpr = () => {
	const [dpr, setDPR] = useState(
		typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio, 2),
	);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		const handleDPRChange = () => {
			setDPR(Math.min(window.devicePixelRatio, 2));
		};

		const windowMatch = window.matchMedia(
			`screen and (min-resolution: ${dpr}dppx)`,
		);

		windowMatch.addEventListener("change", handleDPRChange);

		return () => {
			windowMatch.removeEventListener("change", handleDPRChange);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dpr]);

	return dpr;
};
