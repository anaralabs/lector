import type { Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";

// rAF-driven velocity sample. Idle time produces zero React state updates.
const useVirtualizerVelocity = ({
	virtualizer,
}: {
	virtualizer: Virtualizer<HTMLDivElement, Element> | null;
}) => {
	const [velocity, setVelocity] = useState<number>(0);
	const [normalizedVelocity, setNormalizedVelocity] = useState<number>(0);
	const lastOffsetRef = useRef<number>(0);
	const lastTickRef = useRef<number>(0);
	const rafRef = useRef<number | null>(null);
	// Mirror velocity state so the rAF loop can read "is current velocity
	// nonzero" without putting velocity / normalizedVelocity in the effect
	// deps — those changing every tick would rebind the scroll listener.
	const velocityRef = useRef<number>(0);

	useEffect(() => {
		if (!virtualizer) return;
		const container = virtualizer.scrollElement;
		if (!container) return;

		const onScroll = () => {
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
				velocityRef.current = newVelocity;
				setVelocity(newVelocity);
				setNormalizedVelocity(newVelocity / size);
				lastTickRef.current = now;
				rafRef.current = requestAnimationFrame(tick);
				return;
			}

			// One quiet frame isn't "stopped" — keep sampling until ~100ms of
			// zero-delta, then settle to zero and stop the rAF loop.
			if (now - lastTickRef.current < 100) {
				rafRef.current = requestAnimationFrame(tick);
				return;
			}
			if (velocityRef.current !== 0) {
				velocityRef.current = 0;
				setVelocity(0);
				setNormalizedVelocity(0);
			}
		};

		container.addEventListener("scroll", onScroll, { passive: true });
		lastOffsetRef.current = virtualizer.scrollOffset ?? 0;
		return () => {
			container.removeEventListener("scroll", onScroll);
			if (rafRef.current != null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [virtualizer]);

	return { velocity, normalizedVelocity };
};

export default useVirtualizerVelocity;
