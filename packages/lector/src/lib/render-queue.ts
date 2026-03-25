type RenderJob = {
	execute: () => Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
	cancelled: boolean;
};

/**
 * Serializes PDF page render operations so only one runs at a time.
 * This prevents multiple heavy pages from competing for CPU and blocking the UI.
 */
class RenderQueue {
	private queue: RenderJob[] = [];
	private running = false;

	enqueue(execute: () => Promise<void>): {
		promise: Promise<void>;
		cancel: () => void;
	} {
		let resolve: () => void;
		let reject: (error: unknown) => void;

		const promise = new Promise<void>((res, rej) => {
			resolve = res;
			reject = rej;
		});

		const job: RenderJob = {
			execute,
			resolve: resolve!,
			reject: reject!,
			cancelled: false,
		};

		this.queue.push(job);
		this.flush();

		return {
			promise,
			cancel: () => {
				job.cancelled = true;
				job.resolve();
			},
		};
	}

	private async flush() {
		if (this.running) return;
		this.running = true;

		while (this.queue.length > 0) {
			const job = this.queue.shift()!;

			if (job.cancelled) {
				job.resolve();
				continue;
			}

			try {
				await job.execute();
				job.resolve();
			} catch (error) {
				job.reject(error);
			}
		}

		this.running = false;
	}
}

export const renderQueue = new RenderQueue();
