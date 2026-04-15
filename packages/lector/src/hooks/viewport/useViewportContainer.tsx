import { useGesture } from "@use-gesture/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import { usePdf } from "../../internal";
import { clamp } from "../../lib/clamp";
import { firstMemo } from "../../lib/memo";

const WHEEL_ZOOM_SENSITIVITY = 0.01;
// Heuristics for suppressing trackpad inertia after a CTRL+wheel zoom.
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
	const [origin, setOrigin] = useState<[number, number]>([0, 0]);
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
		zoom,
	});

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

			// Read natural dimensions BEFORE writing the transform — avoids
			// forced synchronous layout. getBoundingClientRect() after a
			// transform write forces Firefox to re-rasterize the compositor
			// layer mid-frame, briefly flashing the canvas background color.
			const naturalWidth =
				parseFloat(elementRef.current.style.width) ||
				elementRef.current.offsetWidth;
			const naturalHeight =
				parseFloat(elementRef.current.style.height) ||
				elementRef.current.offsetHeight;

			// Batch all writes — no layout reads after this point.
			elementRef.current.style.transform = `scale3d(${zoom}, ${zoom}, 1)`;
			elementWrapperRef.current.style.width = `${naturalWidth * zoom}px`;
			elementWrapperRef.current.style.height = `${naturalHeight * zoom}px`;
			containerRef.current.scrollTop = translateY;
			containerRef.current.scrollLeft = translateX;

			if (zoomUpdate) updateZoom(() => transformations.current.zoom);
		},
		[containerRef, elementRef, elementWrapperRef, updateZoom],
	);

	useEffect(() => {
		if (transformations.current.zoom === zoom || !containerRef.current) {
			return;
		}

		const prevZoom = transformations.current.zoom;
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

	// Prevent scroll when CTRL is held (zoom mode) and suppress the inertial tail
	// after releasing CTRL so the PDF doesn't "keep scrolling" from trackpad velocity.
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

					const contentPosition: [number, number] = [
						origin[0] - elementRect.left,
						origin[1] - elementRect.top,
					];

					const containerPosition: [number, number] = [
						origin[0] - containerRect.left,
						origin[1] - containerRect.top,
					];

					setOrigin([
						contentPosition[0] / currentZoom,
						contentPosition[1] / currentZoom,
					]);

					return {
						contentPosition,
						containerPosition,
						originZoom: currentZoom,
						lastZoom: currentZoom,
					};
				});

				if (first) {
					return newMemo;
				}

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
				const realMs = newZoom / newMemo.originZoom;

				const newTranslateX =
					newMemo.contentPosition[0] * realMs - newMemo.containerPosition[0];
				const newTranslateY =
					newMemo.contentPosition[1] * realMs - newMemo.containerPosition[1];

				transformations.current = {
					zoom: newZoom,
					translateX: newTranslateX,
					translateY: newTranslateY,
				};

				newMemo.lastZoom = newZoom;
				updateTransform(true);

				return newMemo;
			},
			onPinchStart: () => setIsPinching(true),
			onPinchEnd: () => setIsPinching(false),
		},
		{
			target: containerRef,
		},
	);

	return {
		origin,
	};
};
