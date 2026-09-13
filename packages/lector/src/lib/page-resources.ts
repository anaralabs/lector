import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

type Request = {
	promise: Promise<PDFPageProxy>;
	resolve: (page: PDFPageProxy) => void;
	reject: (error: unknown) => void;
};

/** Owns a document's bounded, deduplicated page acquisition queue. */
export class PageResources {
	private pages = new Map<number, PDFPageProxy>();
	private requests = new Map<number, Request>();
	private queue: number[] = [];
	private active = 0;
	private disposed = false;
	private listeners = new Set<() => void>();
	private notification: ReturnType<typeof setTimeout> | undefined;
	private viewports: PageViewport[];
	private completePages: PDFPageProxy[] | undefined;
	private viewportUpdates = new Map<number, PageViewport>();

	constructor(
		private document: PDFDocumentProxy,
		firstPage: PDFPageProxy,
		private rotation: number,
		private onError: (error: unknown) => void,
		private concurrency = 16,
	) {
		this.pages.set(firstPage.pageNumber, firstPage);
		const viewport = this.viewportFor(firstPage);
		this.viewports = Array.from({ length: document.numPages }, () => viewport);
		if (document.numPages === 1) this.completePages = [firstPage];
	}

	private viewportFor(page: PDFPageProxy) {
		return page.getViewport({
			scale: 1,
			rotation: this.rotation + (page.rotate || 0),
		});
	}

	get(pageNumber: number) {
		return this.pages.get(pageNumber);
	}

	getSnapshot = () => ({
		viewports: this.viewports,
		pageProxies: this.completePages,
	});

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** Visible pages move ahead of the background queue; in-flight requests are shared. */
	load = (pageNumber: number): Promise<PDFPageProxy> => {
		if (this.disposed)
			return Promise.reject(new Error("Document page loading was cancelled"));
		if (
			!Number.isInteger(pageNumber) ||
			pageNumber < 1 ||
			pageNumber > this.document.numPages
		)
			return Promise.reject(
				new RangeError(`Page ${pageNumber} does not exist`),
			);
		const page = this.pages.get(pageNumber);
		if (page) return Promise.resolve(page);
		const existing = this.requests.get(pageNumber);
		if (existing) {
			const queued = this.queue.indexOf(pageNumber);
			if (queued > 0) {
				this.queue.splice(queued, 1);
				this.queue.unshift(pageNumber);
			}
			return existing.promise;
		}
		const request = this.createRequest(pageNumber);
		this.queue.unshift(pageNumber);
		this.pump();
		return request.promise;
	};

	private createRequest(pageNumber: number) {
		let resolve!: Request["resolve"];
		let reject!: Request["reject"];
		const promise = new Promise<PDFPageProxy>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const request = { promise, resolve, reject };
		this.requests.set(pageNumber, request);
		return request;
	}

	/** Start after the reader mounts, so unrelated page metadata cannot delay its first render. */
	start = () => {
		if (this.disposed) return;
		for (
			let pageNumber = 1;
			pageNumber <= this.document.numPages;
			pageNumber++
		) {
			if (this.pages.has(pageNumber) || this.requests.has(pageNumber)) continue;
			const request = this.createRequest(pageNumber);
			void request.promise.catch(() => {});
			this.queue.push(pageNumber);
		}
		this.pump();
	};

	loadAll = async (): Promise<PDFPageProxy[]> => {
		if (this.disposed) throw new Error("Document page loading was cancelled");
		if (this.completePages) return this.completePages;
		this.start();
		await Promise.all(
			Array.from({ length: this.document.numPages }, (_, index) => {
				const pageNumber = index + 1;
				return (
					this.pages.get(pageNumber) ?? this.requests.get(pageNumber)!.promise
				);
			}),
		);
		return this.completePages!;
	};

	private pump() {
		while (
			!this.disposed &&
			this.active < this.concurrency &&
			this.queue.length
		) {
			const pageNumber = this.queue.shift()!;
			const request = this.requests.get(pageNumber)!;
			this.active++;
			void Promise.resolve()
				.then(() => {
					if (this.disposed)
						throw new Error("Document page loading was cancelled");
					return this.document.getPage(pageNumber);
				})
				.then((page) => {
					if (this.disposed) return;
					const viewport = this.viewportFor(page);
					this.pages.set(pageNumber, page);
					// Replace snapshots so selectors and memoized layout see each committed batch.
					this.viewportUpdates.set(pageNumber - 1, viewport);
					if (this.pages.size === this.document.numPages) {
						this.completePages = Array.from(
							{ length: this.document.numPages },
							(_, index) => this.pages.get(index + 1)!,
						);
					}
					this.requests.delete(pageNumber);
					request.resolve(page);
					this.notify();
				})
				.catch((error) => {
					if (!this.disposed) {
						this.requests.delete(pageNumber);
						request.reject(error);
						this.onError(error);
					}
				})
				.finally(() => {
					this.active--;
					this.pump();
				});
		}
	}

	private notify() {
		if (this.notification !== undefined) return;
		this.notification = setTimeout(() => {
			this.notification = undefined;
			if (this.disposed) return;
			this.viewports = this.viewports.slice();
			for (const [index, viewport] of this.viewportUpdates)
				this.viewports[index] = viewport;
			this.viewportUpdates.clear();
			for (const listener of this.listeners) listener();
		}, 0);
	}

	dispose = () => {
		this.disposed = true;
		clearTimeout(this.notification);
		this.listeners.clear();
		this.queue = [];
		for (const request of this.requests.values())
			request.reject(new Error("Document page loading was cancelled"));
		this.requests.clear();
	};
}
