/** biome-ignore-all lint/suspicious/noArrayIndexKey: <index react> */
import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";
import { usePdf } from "../../internal";
import { createDarkModeColorMap } from "../../lib/dark-mode";

interface CustomSelectionProps {
	textColor?: string;
	bgColor?: string;
}

export const CustomSelection = ({
	textColor = "#017aff",
	bgColor = "#ebf4ff94",
}: CustomSelectionProps) => {
	const customSelectionRects = usePdf((state) => state.customSelectionRects);
	const colorScheme = usePdf((state) => state.colorScheme);
	const darkModeColors = usePdf((state) => state.darkModeColors);

	const pageNumber = usePDFPageNumber();

	const rects = customSelectionRects.filter(
		(area) => area.pageNumber === pageNumber,
	);

	if (!rects.length) return null;

	// Run the light-tuned defaults through the same map as the page so the
	// selection chrome composites sensibly against natively dark pixels.
	const isDark = colorScheme === "dark";
	const map = isDark ? createDarkModeColorMap(darkModeColors) : null;
	const displayTextColor = map ? map(textColor) : textColor;
	const displayBgColor = map ? map(bgColor) : bgColor;

	return (
		<>
			{rects.map((rect, index) => (
				<span
					key={index}
					style={{
						position: "absolute",
						top: rect.top,
						left: rect.left,
						height: rect.height,
						width: rect.width,
						pointerEvents: "none",
						zIndex: 30,
						background: displayTextColor,
						mixBlendMode: "color",
					}}
				/>
			))}
			{rects.map((rect, index) => (
				<span
					key={`bg-${index}`}
					style={{
						position: "absolute",
						top: rect.top,
						left: rect.left,
						height: rect.height,
						width: rect.width,
						pointerEvents: "none",
						background: displayBgColor,
						// "multiply" tints a light page; "screen" is the dark-page
						// equivalent (lightens instead of darkening to near-black).
						mixBlendMode: isDark ? "screen" : "multiply",
					}}
				/>
			))}
		</>
	);
};
