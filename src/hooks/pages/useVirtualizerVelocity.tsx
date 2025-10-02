import type { Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useState } from "react";

const useVirtualizerVelocity = ({
	virtualizer,
}: {
	virtualizer: Virtualizer<HTMLDivElement, Element> | null;
}) => {
	const [lastScrollOffset, setLastScrollOffset] = useState<number>(0);
	const [velocity, setVelocity] = useState<number>(0);
	const [normalizedVelocity, setNormalizedVelocity] = useState<number>(0);

	useEffect(() => {
		if (!virtualizer) return;
		const interval = setInterval(() => {
			// Get the current scroll offset
			const currentScrollOffset = virtualizer.scrollOffset;

			if (currentScrollOffset == null) {
				return;
			}

			// Calculate the difference (velocity)
			const newVelocity = currentScrollOffset - lastScrollOffset;

			// velocity is normalized by the height of the element
			// so the interpretation is how many heights of a page
			// the page is scrolling per 100ms.
			const estimateSize = virtualizer.options.estimateSize;
			setNormalizedVelocity(newVelocity / estimateSize(0));

			// Update the state with the new values
			setLastScrollOffset(currentScrollOffset);
			setVelocity(newVelocity);

			// Optionally, log the velocity
			//   console.log("Scroll offset velocity:", newVelocity);
		}, 50); // Adjust the interval for more/less frequent checks

		// Clear the interval on component unmount
		return () => clearInterval(interval);
	}, [lastScrollOffset, virtualizer]);

	return { velocity, normalizedVelocity };
};

export default useVirtualizerVelocity;
