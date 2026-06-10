/** biome-ignore-all lint/suspicious/noArrayIndexKey: <index react> */
import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";
import { usePdf } from "../../internal";
import { createDarkModeColorMap } from "../../lib/dark-mode";

interface CustomSelectionProps {
	textColor?: string;
	bgColor?: string;
}

// The light default tint (#ebf4ff94) maps onto the dark ramp as a near-paper
// color — screened over the dark page it would be invisible. The dark default
// is tuned directly: a dim blue that screen-lifts the paper visibly without
// washing out the light text.
const DEFAULT_TEXT_COLOR = "#017aff";
const DEFAULT_BG_COLOR = "#ebf4ff94";
const DEFAULT_DARK_BG_COLOR = "#2a4a7a94";

export const CustomSelection = ({
	textColor = DEFAULT_TEXT_COLOR,
	bgColor = DEFAULT_BG_COLOR,
}: CustomSelectionProps) => {
	const customSelectionRects = usePdf((state) => state.customSelectionRects);
	const colorScheme = usePdf((state) => state.colorScheme);
	const darkModeColors = usePdf((state) => state.darkModeColors);

	const pageNumber = usePDFPageNumber();

	const rects = customSelectionRects.filter(
		(area) => area.pageNumber === pageNumber,
	);

	if (!rects.length) return null;

	// Run colors through the same map as the page so the selection chrome
	// composites sensibly against natively dark pixels. The default bg tint
	// swaps to a dark-tuned value instead (see DEFAULT_DARK_BG_COLOR).
	const isDark = colorScheme === "dark";
	const map = isDark ? createDarkModeColorMap(darkModeColors) : null;
	const displayTextColor = map ? map(textColor) : textColor;
	const displayBgColor = isDark
		? bgColor === DEFAULT_BG_COLOR
			? DEFAULT_DARK_BG_COLOR
			: map!(bgColor)
		: bgColor;

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
