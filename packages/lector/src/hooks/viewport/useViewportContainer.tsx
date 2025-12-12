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

			elementRef.current.style.transform = `scale3d(${zoom}, ${zoom}, 1)`;
			elementRef.current.style.willChange = "scale3d";

			const elementBoundingBox = elementRef.current.getBoundingClientRect();

			const width = elementBoundingBox.width;

			elementWrapperRef.current.style.width = `${width}px`;
			elementWrapperRef.current.style.height = `${elementBoundingBox.height}px`;

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
