import { useEffect, useState } from "react";

// dpr-3 phones (recent iPhones, most Android flagships) look visibly soft at
// a cap of 2; the page-area clamp in canvas-utils already bounds the memory
// cost of rendering at 3.
const DPR_CAP = 3;

const readDpr = () =>
	typeof window === "undefined"
		? 1
		: Math.min(window.devicePixelRatio || 1, DPR_CAP);

export const useDpr = () => {
	const [dpr, setDpr] = useState(readDpr);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		let mediaQuery: MediaQueryList | null = null;
		let cancelled = false;

		const handleChange = () => {
			if (cancelled) {
				return;
			}
			setDpr(readDpr());
			subscribe();
		};

		// Safari <14 MediaQueryList only has addListener/removeListener.
		const unlisten = (mql: MediaQueryList | null) => {
			if (!mql) return;
			if (typeof mql.removeEventListener === "function") {
				mql.removeEventListener("change", handleChange);
			} else {
				mql.removeListener(handleChange);
			}
		};

		const subscribe = () => {
			unlisten(mediaQuery);
			// Exact-match query built from the live, UNCAPPED devicePixelRatio: it
			// flips (and fires "change") on any deviation in either direction. A
			// min-resolution query only fires when the ratio drops below it, so
			// moving to a denser display or raising browser zoom would never be
			// observed. The -webkit alternative covers older Safari, which lacks
			// the standard resolution feature in matchMedia.
			const ratio = window.devicePixelRatio || 1;
			mediaQuery = window.matchMedia(
				`(resolution: ${ratio}dppx), (-webkit-device-pixel-ratio: ${ratio})`,
			);
			if (typeof mediaQuery.addEventListener === "function") {
				mediaQuery.addEventListener("change", handleChange, { once: true });
			} else {
				mediaQuery.addListener(handleChange);
			}
		};

		// Re-sync before subscribing: a DPR change between the initial render
		// and this (passive) effect would otherwise leave the state stale while
		// the query — built from the already-changed live value — matches and
		// never fires. setState with an unchanged value is a no-op re-render.
		setDpr(readDpr());
		subscribe();

		return () => {
			cancelled = true;
			unlisten(mediaQuery);
		};
	}, []);

	return dpr;
};
