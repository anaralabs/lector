import type { Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";

// rAF-driven velocity sample. Runs only while the user is actively scrolling
// (a passive scroll listener flips the active flag; rAF reads offset and
// decays the flag when scrolling stops). Replaces a 50ms setInterval that
// fired 20×/sec regardless of whether the page was being scrolled — that
// poll did ~20 React state updates per second of idle time.
const useVirtualizerVelocity = ({
	virtualizer,
}: {
	virtualizer: Virtualizer<HTMLDivElement, Element> | null;
}) => {
	const [velocity, setVelocity] = useState<number>(0);
	const [normalizedVelocity, setNormalizedVelocity] = useState<number>(0);
	const lastOffsetRef = useRef<number>(0);
	const lastTickRef = useRef<number>(0);
	const activeRef = useRef<boolean>(false);
	const rafRef = useRef<number | null>(null);

	useEffect(() => {
		if (!virtualizer) return;
		const container = virtualizer.scrollElement;
		if (!container) return;

		const onScroll = () => {
			activeRef.current = true;
			if (rafRef.current == null) {
				rafRef.current = requestAnimationFrame(tick);
			}
		};

		const tick = (now: number) => {
			rafRef.current = null;
			const offset = virtualizer.scrollOffset;
			if (offset == null) return;
			const last = lastOffsetRef.current;
			const newVelocity = offset - last;
			lastOffsetRef.current = offset;

			if (newVelocity !== 0) {
				const estimateSize = virtualizer.options.estimateSize;
				const size = estimateSize(0) || 1;
				setVelocity(newVelocity);
				setNormalizedVelocity(newVelocity / size);
				lastTickRef.current = now;
				rafRef.current = requestAnimationFrame(tick);
				return;
			}

			// One quiet frame is not enough to declare "stopped" — keep
			// sampling until ~100ms of zero-delta has elapsed, then settle to
			// zero velocity and stop the rAF loop.
			if (now - lastTickRef.current < 100) {
				rafRef.current = requestAnimationFrame(tick);
				return;
			}
			activeRef.current = false;
			if (velocity !== 0 || normalizedVelocity !== 0) {
				setVelocity(0);
				setNormalizedVelocity(0);
			}
		};

		container.addEventListener("scroll", onScroll, { passive: true });
		// Seed lastOffset so the first scroll computes a real delta.
		lastOffsetRef.current = virtualizer.scrollOffset ?? 0;
		return () => {
			container.removeEventListener("scroll", onScroll);
			if (rafRef.current != null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [virtualizer, normalizedVelocity, velocity]);

	return { velocity, normalizedVelocity };
};

export default useVirtualizerVelocity;
