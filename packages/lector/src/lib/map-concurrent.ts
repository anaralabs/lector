/** Ordered results with bounded in-flight work and cooperative cancellation. */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	concurrency: number,
	map: (item: T, index: number) => Promise<R>,
	isCancelled: () => boolean = () => false,
): Promise<R[]> {
	if (!Number.isFinite(concurrency) || concurrency < 1)
		throw new RangeError("Concurrency must be positive and finite");
	const results = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	const worker = async () => {
		while (next < items.length) {
			if (failed || isCancelled())
				throw new DOMException("Operation aborted", "AbortError");
			const index = next++;
			try {
				results[index] = await map(items[index]!, index);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(Math.max(1, Math.floor(concurrency)), items.length) },
			worker,
		),
	);
	if (isCancelled()) throw new DOMException("Operation aborted", "AbortError");
	return results;
}
