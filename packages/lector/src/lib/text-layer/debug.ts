export const logTextLayerDebug = (...args: unknown[]) => {
	if (
		typeof window !== "undefined" &&
		(globalThis as { __LECTOR_DEBUG_TEXT_LAYER__?: boolean })
			.__LECTOR_DEBUG_TEXT_LAYER__
	) {
		console.info("[lector:text-layer]", ...args);
	}
};
