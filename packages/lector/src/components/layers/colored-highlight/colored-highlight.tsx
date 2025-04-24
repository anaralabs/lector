import { useState } from "react";

import { type ColoredHighlight,usePdf } from "../../../internal";
import {
  getEndOfHighlight,
  getMidHeightOfHighlightLine,
} from "../../../utils/selectionUtils";

type ColoredHighlightComponentProps = {
  selection: ColoredHighlight;
};

export const ColoredHighlightComponent = ({
  selection,
}: ColoredHighlightComponentProps) => {
  const deleteColoredHighlight = usePdf(
    (state) => state.deleteColoredHighlight,
  );
  const [showButton, setShowButton] = useState(false);

  return (
    <div className="colored-highlight">
      {selection.rectangles.map((rect, index) => (
        <span
          key={`${selection.uuid}-${index}`}
          onClick={() => setShowButton(!showButton)}
          style={{
            position: "absolute",
            top: rect.top,
            left: rect.left,
            height: rect.height,
            width: rect.width,
            cursor: "pointer",
            zIndex: 30,
            backgroundColor: selection.color,
            // mixBlendMode: "lighten", // changes the color of the text
            mixBlendMode: "darken", // best results
            // mixBlendMode: "multiply", // works but coloring has some inconsistencies
            borderRadius: "0.2rem",
          }}
        />
      ))}
      {showButton && (
        <button
          key={`${selection.uuid}-delete-button`}
          style={{
            backgroundColor: "white",
            color: "white",
            borderRadius: "5px",
            padding: "5px",
            cursor: "pointer",
            boxShadow: "2px 2px 5px black",
            position: "absolute",
            top: getMidHeightOfHighlightLine(selection),
            left: getEndOfHighlight(selection),
            zIndex: 30,
            transform: "translateY(-50%)",
          }}
          onClick={() => deleteColoredHighlight(selection.uuid)}
        >
          <svg
            fill="#000000"
            version="1.1"
            id="Capa_1"
            xmlns="http://www.w3.org/2000/svg"
            width="15px"
            height="15px"
            viewBox="0 0 485 485"
          >
            <g>
              <g>
                <rect x="67.224" width="350.535" height="71.81" />
                <path
                  d="M417.776,92.829H67.237V485h350.537V92.829H417.776z M165.402,431.447h-28.362V146.383h28.362V431.447z M256.689,431.447
			h-28.363V146.383h28.363V431.447z M347.97,431.447h-28.361V146.383h28.361V431.447z"
                />
              </g>
            </g>
          </svg>
        </button>
      )}
    </div>
  );
};
