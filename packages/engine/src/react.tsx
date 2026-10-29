// React binding. The viewer is imperative; React only mounts it and passes
// options through. Nothing here re-renders while scrolling or zooming.

import { type CSSProperties, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { CoreEvent, CoreOptions } from "./core";
import { createViewer, type Viewer, type ViewerOptions } from "./viewer";

export interface LectorViewProps extends Omit<ViewerOptions, "onEvent" | keyof CoreOptions> {
	source: string | ArrayBuffer | Uint8Array;
	/** live-updatable engine options (dark mode, colours, ...) */
	options?: Partial<CoreOptions>;
	onEvent?: (e: CoreEvent) => void;
	onViewer?: (viewer: Viewer | null) => void;
	className?: string;
	style?: CSSProperties;
}

export const LectorView = forwardRef<Viewer | null, LectorViewProps>(function LectorView(
	{ source, options, onEvent, onViewer, className, style, wasmUrl, workers, offscreen, onLink, createWorker, workerUrls },
	ref,
) {
	const container = useRef<HTMLDivElement>(null);
	const [viewer, setViewer] = useState<Viewer | null>(null);
	const latest = useRef({ onEvent, onViewer, onLink, options, createWorker });
	useLayoutEffect(() => {
		latest.current = { onEvent, onViewer, onLink, options, createWorker };
	});

	useEffect(() => {
		const el = container.current;
		if (!el) return;
		let cancelled = false;
		let created: Viewer | null = null;
		createViewer(el, source, {
			wasmUrl,
			workers,
			offscreen,
			createWorker: latest.current.createWorker,
			workerUrls,
			...latest.current.options,
			onEvent: (e) => latest.current.onEvent?.(e),
			onLink: latest.current.onLink ? (url) => latest.current.onLink?.(url) : undefined,
		}).then(
			(v) => {
				if (cancelled) {
					v.destroy();
					return;
				}
				created = v;
				setViewer(v);
				latest.current.onViewer?.(v);
			},
			(err) => latest.current.onEvent?.({ type: "error", message: String(err?.message ?? err) }),
		);
		return () => {
			cancelled = true;
			created?.destroy();
			setViewer(null);
			latest.current.onViewer?.(null);
		};
	}, [source, wasmUrl, workers, offscreen]);

	const optionsKey = JSON.stringify(options ?? {});
	useEffect(() => {
		if (viewer && options) viewer.setOptions(options);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [viewer, optionsKey]);

	useImperativeHandle(ref, () => viewer as Viewer, [viewer]);

	return <div ref={container} className={className} style={{ position: "relative", ...style }} />;
});
