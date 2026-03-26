import { type HTMLProps, useEffect, useRef, useState } from "react";

import { usePdf } from "../internal";
import { Primitive } from "./primitive";

export const ZoomIn = ({ ...props }: HTMLProps<HTMLButtonElement>) => {
	const setZoom = usePdf((state) => state.updateZoom);

	return (
		<Primitive.button
			{...props}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			onClick={(e: any) => {
				props.onClick?.(e);
				setZoom((zoom) => Number((zoom + 0.1).toFixed(1)));
			}}
		/>
	);
};

export const ZoomOut = ({ ...props }: HTMLProps<HTMLButtonElement>) => {
	const setZoom = usePdf((state) => state.updateZoom);

	return (
		<Primitive.button
			{...props}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			onClick={(e: any) => {
				props.onClick?.(e);
				setZoom((zoom) => Number((zoom - 0.1).toFixed(1)));
			}}
		/>
	);
};

export const CurrentZoom = ({ ...props }: HTMLProps<HTMLInputElement>) => {
	const updateZoom = usePdf((state) => state.updateZoom);
	const realZoom = usePdf((state) => state.zoom);

	const [zoom, setZoom] = useState<string>((realZoom * 100).toFixed(0));
	const isInputFocused = useRef<boolean>(false);

	useEffect(() => {
		if (isInputFocused.current) {
			return;
		}

		setZoom((realZoom * 100).toFixed(0));
	}, [realZoom]);

	return (
		<input
			{...props}
			value={zoom}
			onClick={() => {
				isInputFocused.current = true;
			}}
			onChange={(e) => {
				updateZoom(Number(e.target.value) / 100);
				setZoom(e.target.value);
			}}
			onBlur={() => {
				isInputFocused.current = false;

				setZoom((realZoom * 100).toFixed(0));
			}}
		/>
	);
};
