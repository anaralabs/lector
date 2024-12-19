import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";
import { usePdf } from "../../internal";

interface CustomSelectionProps {
  textColor?: string;
  bgColor?: string;
}

export const CustomSelection = ({
  textColor = "#017aff",
  bgColor = "#ebf4ff94",
}: CustomSelectionProps) => {
  const customSelectionRects = usePdf((state) => state.customSelectionRects);

  const pageNumber = usePDFPageNumber();

  const rects = customSelectionRects.filter(
    (area) => area.pageNumber === pageNumber,
  );

  if (!rects.length) return null;

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
            background: textColor,
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
            background: bgColor,
            mixBlendMode: "multiply",
          }}
        />
      ))}
    </>
  );
};
