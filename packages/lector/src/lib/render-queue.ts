type Priority = "visible" | "overscan" | "background";

const PRIORITY_ORDER: Record<Priority, number> = {
	visible: 0,
	overscan: 1,
	background: 2,
};

type RenderJob = {
	execute: () => Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
	cancelled: boolean;
	priority: Priority;
};

/**
 * Serializes PDF page render operations with priority ordering and limited
 * parallelism. Visible pages render first, overscan pages next, background last.
 * Up to `concurrency` jobs run simultaneously to utilise GPU without starving
 * the main thread.
 */
class RenderQueue {
	private queue: RenderJob[] = [];
	private activeCount = 0;
	private concurrency: number;

	constructor(concurrency = 3) {
		this.concurrency = concurrency;
	}

	enqueue(
		execute: () => Promise<void>,
		priority: Priority = "overscan",
	): {
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
			priority,
		};

		// Insert sorted by priority (lower number = higher priority)
		const insertIdx = this.queue.findIndex(
			(j) => PRIORITY_ORDER[j.priority] > PRIORITY_ORDER[priority],
		);
		if (insertIdx === -1) {
			this.queue.push(job);
		} else {
			this.queue.splice(insertIdx, 0, job);
		}

		this.flush();

		return {
			promise,
			cancel: () => {
				job.cancelled = true;
				job.resolve();
			},
		};
	}

	private flush() {
		while (this.activeCount < this.concurrency && this.queue.length > 0) {
			const job = this.queue.shift()!;

			if (job.cancelled) {
				job.resolve();
				continue;
			}

			this.activeCount++;
			job
				.execute()
				.then(() => job.resolve())
				.catch((error) => job.reject(error))
				.finally(() => {
					this.activeCount--;
					this.flush();
				});
		}
	}
}

/**
 * Global singleton — intentionally shared across all <Root> instances.
 * Allows up to 3 concurrent renders for better throughput while preventing
 * GPU/CPU over-subscription.
 */
export const renderQueue = new RenderQueue(3);
