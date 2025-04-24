import { SelectionTooltip } from "../../selection-tooltip";

type ColorSelectionToolProps = {
  highlighterColors?: colorItem[];
  onColorSelection: (colorItem: colorItem) => void;
};

type colorItem = {
  color: string;
  localization: {
    id: string;
    defaultMessage: string;
  };
};

const defaultColors: colorItem[] = [
  {
    color: "#e3b127",
    localization: {
      id: "yellow",
      defaultMessage: "Yellow",
    },
  },
  {
    color: "#419931",
    localization: {
      id: "green",
      defaultMessage: "Green",
    },
  },
  {
    color: "#4286c9",
    localization: {
      id: "blue",
      defaultMessage: "Blue",
    },
  },
  {
    color: "#f246b6",
    localization: {
      id: "pink",
      defaultMessage: "Pink",
    },
  },
  {
    color: "#a53dd1",
    localization: {
      id: "purple",
      defaultMessage: "Purple",
    },
  },
  {
    color: "#f09037",
    localization: {
      id: "orange",
      defaultMessage: "Orange",
    },
  },
  {
    color: "#37f0d4",
    localization: {
      id: "teal",
      defaultMessage: "Teal",
    },
  },
  {
    color: "#3d0ff5",
    localization: {
      id: "purple",
      defaultMessage: "Purple",
    },
  },
  {
    color: "#f50f26",
    localization: {
      id: "red",
      defaultMessage: "Red",
    },
  },
];

export const ColorSelectionTool = ({
  highlighterColors = defaultColors,
  onColorSelection,
}: ColorSelectionToolProps) => {
  return (
    <SelectionTooltip>
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          padding: "0.5rem",
          backgroundColor: "#363636",
          borderRadius: "0.5rem",
        }}
      >
        {highlighterColors.map((colorItem, index) => (
          <button
            key={index}
            onClick={() => onColorSelection(colorItem)}
            title={colorItem.localization.defaultMessage}
            aria-label={colorItem.localization.defaultMessage}
            style={{
              width: "1.25rem",
              height: "1.25rem",
              borderRadius: "0.25rem",
              cursor: "pointer",
              backgroundColor: colorItem.color,
            }}
          />
        ))}
      </div>
    </SelectionTooltip>
  );
};
