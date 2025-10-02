import type { HTMLProps } from "react";

import { useCanvasLayer } from "../../hooks/layers/useCanvasLayer";
import { useDetailCanvasLayer } from "../../hooks/layers/useDetailCanvasLayer";

export const CanvasLayer = ({
	style,
	background,
	...props
}: HTMLProps<HTMLCanvasElement> & {
	background?: string;
}) => {
	const { canvasRef } = useCanvasLayer({ background });
	const { detailCanvasRef, containerRef } = useDetailCanvasLayer({
		background,
		baseCanvasRef: canvasRef,
	});

	return (
		<>
			<canvas {...props} ref={canvasRef} style={style} />
			<div
				ref={containerRef}
				className="absolute top-0 left-0 w-full h-full flex items-center justify-center"
			>
				<canvas ref={detailCanvasRef} />
			</div>
		</>
	);
};
