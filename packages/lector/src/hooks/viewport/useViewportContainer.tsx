import { useGesture } from "@use-gesture/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";

import { PDFStore, usePdf } from "../../internal";
import { clamp } from "../../lib/clamp";
import { firstMemo } from "../../lib/memo";
import { registerViewportZoom } from "../../lib/viewport-zoom";
import { USE_LAYOUT_ZOOM } from "../../lib/zoom";

const WHEEL_ZOOM_SENSITIVITY = 0.01;
const WHEEL_INERTIA_GAP_MS = 140;
const WHEEL_INERTIA_ESCAPE_FACTOR = 1.35;

export const useViewportContainer = ({
	containerRef,
	elementWrapperRef,
	elementRef,
}: {
	containerRef: RefObject<HTMLDivElement | null>;
	elementWrapperRef: RefObject<HTMLDivElement | null>;
	elementRef: RefObject<HTMLDivElement | null>;
}) => {
	const store = PDFStore.useContext();
	const isPinching = usePdf((state) => state.isPinching);
	const gestureTransformAppliedRef = useRef(false);
	const originRef = useRef<[number, number]>([0, 0]);
	const wheelInertia = useRef<{
		active: boolean;
		lastTime: number;
		lastAbsDeltaY: number;
		lastSign: -1 | 0 | 1;
	}>({
		active: false,
		lastTime: 0,
		lastAbsDeltaY: 0,
		lastSign: 0,
	});

	const { maxZoom, minZoom } = usePdf((state) => state.zoomOptions);
	const zoom = usePdf((state) => state.zoom);
	const viewportRef = usePdf((state) => state.viewportRef);

	const setIsPinching = usePdf((state) => state.setIsPinching);
	const updateZoom = usePdf((state) => state.updateZoom);

	useEffect(() => {
		viewportRef.current = containerRef.current;
	}, [containerRef, viewportRef]);

	const transformations = useRef<{
		translateX: number;
		translateY: number;
		zoom: number;
	}>({
		translateX: 0,
		translateY: 0,
		zoom: 1,
	});

	const zoomRafRef = useRef<number | null>(null);
	const lastPushedZoomRef = useRef<number | null>(null);
	const initializedZoomRef = useRef(false);
	const appliedZoomRef = useRef(1);

	const updateTransform = useCallback(
		(zoomUpdate?: boolean) => {
			if (
				!elementRef.current ||
				!containerRef.current ||
				!elementWrapperRef.current
			) {
				return;
			}

			const { zoom, translateX, translateY } = transformations.current;

			const naturalWidth =
				parseFloat(elementRef.current.style.width) ||
				elementRef.current.offsetWidth;
			const naturalHeight =
				parseFloat(elementRef.current.style.height) ||
				elementRef.current.offsetHeight;

			if (USE_LAYOUT_ZOOM) {
				const element = elementRef.current;
				if (store.getState().isPinching) {
					const layoutZoom = parseFloat(element.style.zoom) || 1;
					const gestureScale = zoom / layoutZoom;
					element.style.transform = `scale3d(${gestureScale}, ${gestureScale}, 1)`;
					element.style.willChange = "transform";
					gestureTransformAppliedRef.current = true;
				} else {
					// WebKit downsamples canvases under transformed ancestors: https://bugs.webkit.org/show_bug.cgi?id=264954
					element.style.zoom = String(zoom);
					element.style.transform = "none";
					element.style.willChange = "auto";
					gestureTransformAppliedRef.current = false;
				}
			} else {
				elementRef.current.style.transform = `scale3d(${zoom}, ${zoom}, 1)`;
			}
			elementWrapperRef.current.style.width = `${naturalWidth * zoom}px`;
			elementWrapperRef.current.style.height = `${naturalHeight * zoom}px`;
			containerRef.current.scrollTop = translateY;
			containerRef.current.scrollLeft = translateX;
			appliedZoomRef.current = zoom;

			if (zoomUpdate) {
				lastPushedZoomRef.current = zoom;
				updateZoom(() => zoom);
			}
		},
		[containerRef, elementRef, elementWrapperRef, updateZoom, store],
	);

	useLayoutEffect(() => {
		const viewport = containerRef.current;
		if (!viewport) return;
		return registerViewportZoom(viewport, (nextZoom) => {
			if (
				initializedZoomRef.current &&
				appliedZoomRef.current === nextZoom &&
				zoomRafRef.current === null
			)
				return;
			if (zoomRafRef.current !== null) {
				cancelAnimationFrame(zoomRafRef.current);
				zoomRafRef.current = null;
			}
			lastPushedZoomRef.current = null;
			// Before mount initialization the virtualizer's physical offset
			// already includes the initial store scale.
			const previousZoom = initializedZoomRef.current
				? appliedZoomRef.current
				: store.getState().zoom;
			const ratio =
				previousZoom > 0 && Number.isFinite(previousZoom)
					? nextZoom / previousZoom
					: 1;
			transformations.current = {
				zoom: nextZoom,
				translateX: viewport.scrollLeft * ratio,
				translateY: viewport.scrollTop * ratio,
			};
			initializedZoomRef.current = true;
			updateTransform();
		});
	}, [containerRef, store, updateTransform]);

	useEffect(() => {
		if (USE_LAYOUT_ZOOM && gestureTransformAppliedRef.current && !isPinching)
			updateTransform();
	}, [isPinching, updateTransform]);

	useEffect(() => {
		return () => {
			if (zoomRafRef.current !== null) {
				cancelAnimationFrame(zoomRafRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if (!initializedZoomRef.current && containerRef.current) {
			initializedZoomRef.current = true;
			// The virtualizer restores its offset during layout, already scaled
			// by the initial store zoom. Apply geometry without scaling that
			// physical scroll position a second time.
			transformations.current = {
				zoom,
				translateX: containerRef.current.scrollLeft,
				translateY: containerRef.current.scrollTop,
			};
			updateTransform();
			return;
		}
		if (transformations.current.zoom === zoom || !containerRef.current) {
			return;
		}

		if (zoom === lastPushedZoomRef.current) {
			lastPushedZoomRef.current = null;
			return;
		}

		if (zoomRafRef.current !== null) {
			cancelAnimationFrame(zoomRafRef.current);
			zoomRafRef.current = null;
		}
		lastPushedZoomRef.current = null;

		// A newer gesture value may still be queued for the next frame.
		const prevZoom = appliedZoomRef.current;
		if (!prevZoom || !Number.isFinite(prevZoom)) {
			transformations.current = {
				translateX: containerRef.current.scrollLeft,
				translateY: containerRef.current.scrollTop,
				zoom,
			};
			updateTransform();
			return;
		}

		const dZoom = zoom / prevZoom;

		transformations.current = {
			translateX: containerRef.current.scrollLeft * dZoom,
			translateY: containerRef.current.scrollTop * dZoom,
			zoom,
		};

		updateTransform();
	}, [containerRef, zoom, updateTransform]);

	useEffect(() => {
		const preventDefault = (e: TouchEvent) => e.preventDefault();

		// @ts-expect-error Could be null
		document.addEventListener("gesturestart", preventDefault);
		// @ts-expect-error Could be null
		document.addEventListener("gesturechange", preventDefault);

		return () => {
			// @ts-expect-error Could be null
			document.removeEventListener("gesturestart", preventDefault);
			// @ts-expect-error Could be null
			document.removeEventListener("gesturechange", preventDefault);
		};
	}, []);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const sign = (n: number): -1 | 0 | 1 => (n === 0 ? 0 : n > 0 ? 1 : -1);

		const handleWheelCapture = (event: WheelEvent) => {
			const st = wheelInertia.current;
			const now = Date.now();
			const ctrl = event.ctrlKey || event.metaKey;
			const abs = Math.abs(event.deltaY);
			const s = sign(event.deltaY);

			if (ctrl) {
				st.active = true;
				st.lastTime = now;
				st.lastAbsDeltaY = abs;
				st.lastSign = s;
				event.preventDefault();
				return;
			}

			if (!st.active) {
				return;
			}

			// Pinch-wheel inertia is vertical. A horizontal-dominant gesture
			// is an intentional pan, even immediately after releasing Ctrl.
			if (Math.abs(event.deltaX) > abs) {
				st.active = false;
				return;
			}

			if (now - st.lastTime > WHEEL_INERTIA_GAP_MS) {
				st.active = false;
				return;
			}

			if (st.lastSign !== 0 && s !== 0 && s !== st.lastSign) {
				st.active = false;
				return;
			}
			if (
				st.lastAbsDeltaY > 0 &&
				abs > st.lastAbsDeltaY * WHEEL_INERTIA_ESCAPE_FACTOR + 1
			) {
				st.active = false;
				return;
			}

			st.lastTime = now;
			st.lastAbsDeltaY = abs;
			st.lastSign = s;
			event.preventDefault();
		};

		container.addEventListener("wheel", handleWheelCapture, {
			passive: false,
			capture: true,
		});
		return () => {
			container.removeEventListener("wheel", handleWheelCapture, {
				capture: true,
			} as AddEventListenerOptions);
		};
	}, [containerRef]);

	useGesture(
		{
			onPinch: (state) => {
				const { origin, first, movement, delta, event, memo } = state;
				const [ms] = movement;
				const [deltaScale] = delta;

				const currentElement = elementRef.current;
				const currentContainer = containerRef.current;

				if (!currentElement || !currentContainer) return;

				const newMemo = firstMemo(first, memo, () => {
					const elementRect = currentElement.getBoundingClientRect();
					const containerRect = currentContainer.getBoundingClientRect();
					const currentZoom = transformations.current.zoom;

					const containerStyle = getComputedStyle(currentContainer);
					const paddingTop = parseFloat(containerStyle.paddingTop) || 0;
					const paddingLeft = parseFloat(containerStyle.paddingLeft) || 0;

					const contentPosition: [number, number] = [
						origin[0] - elementRect.left,
						origin[1] - elementRect.top,
					];

					const containerPosition: [number, number] = [
						origin[0] - containerRect.left - paddingLeft,
						origin[1] - containerRect.top - paddingTop,
					];

					originRef.current = [
						contentPosition[0] / currentZoom,
						contentPosition[1] / currentZoom,
					];

					return {
						contentPosition,
						containerPosition,
						originZoom: currentZoom,
						origin: [...origin] as [number, number],
						lastZoom: currentZoom,
					};
				});

				// Wheel gestures include a scale delta in their first event. Apply
				// it on the next frame instead of waiting for another event or end.
				if (first && ms === 1) return newMemo;

				const gestureValuesValid = Number.isFinite(ms) && ms > 0;

				let effectiveScale = ms;
				if (!gestureValuesValid) {
					const wheelEvent = event as WheelEvent;
					if (wheelEvent?.deltaY !== undefined) {
						const wheelDelta = -wheelEvent.deltaY * WHEEL_ZOOM_SENSITIVITY;
						effectiveScale =
							(newMemo.lastZoom / newMemo.originZoom) * (1 + wheelDelta);
					} else if (Number.isFinite(deltaScale) && deltaScale !== 0) {
						effectiveScale =
							(newMemo.lastZoom / newMemo.originZoom) * (1 + deltaScale);
					} else {
						return newMemo;
					}
				}

				const newZoom = clamp(
					effectiveScale * newMemo.originZoom,
					minZoom,
					maxZoom,
				);
				// A moving touch midpoint pans the anchored content. A wheel
				// pointer instead chooses a new content anchor at the previous
				// scale, including updates still queued for the next paint.
				if (event.type === "wheel") {
					const previousScale = newMemo.lastZoom / newMemo.originZoom;
					for (const axis of [0, 1] as const) {
						const movement = origin[axis] - newMemo.origin[axis];
						newMemo.contentPosition[axis] += movement / previousScale;
						newMemo.containerPosition[axis] += movement;
						newMemo.origin[axis] = origin[axis];
					}
				}
				const realMs = newZoom / newMemo.originZoom;

				const newTranslateX =
					newMemo.contentPosition[0] * realMs -
					newMemo.containerPosition[0] -
					(origin[0] - newMemo.origin[0]);
				const newTranslateY =
					newMemo.contentPosition[1] * realMs -
					newMemo.containerPosition[1] -
					(origin[1] - newMemo.origin[1]);

				transformations.current = {
					zoom: newZoom,
					translateX: newTranslateX,
					translateY: newTranslateY,
				};

				newMemo.lastZoom = newZoom;
				// Trackpads can deliver several events before the next paint.
				// Keep their latest anchor/scale, then apply geometry and publish
				// the matching store zoom together once per frame. Scroll writes
				// after size changes force layout, so batching just the store is
				// not enough to keep this path responsive.
				if (zoomRafRef.current === null) {
					zoomRafRef.current = requestAnimationFrame(() => {
						zoomRafRef.current = null;
						updateTransform(true);
					});
				}

				return newMemo;
			},
			onPinchStart: () => setIsPinching(true),
			onPinchEnd: () => {
				const pendingFrame = zoomRafRef.current !== null;
				if (zoomRafRef.current !== null) {
					cancelAnimationFrame(zoomRafRef.current);
					zoomRafRef.current = null;
				}
				setIsPinching(false);
				// A gesture can end before its queued frame. Flush its final
				// position now, restoring native CSS zoom on WebKit before paint.
				// A pinch with no movement must preserve native scrolling.
				if (pendingFrame || gestureTransformAppliedRef.current) {
					updateTransform(pendingFrame);
				}
			},
		},
		{
			target: containerRef,
		},
	);

	return {
		origin: originRef.current,
	};
};
