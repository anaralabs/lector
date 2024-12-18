export const getOffsetForHighlight = ({
  top,
  left,
  height,
  width,
  itemHeight,
  startOffset,
}: {
  top: number;
  left: number;
  height: number;
  width: number;
  itemHeight: number;
  startOffset: number;
}) => {
  const topP = top * itemHeight * 0.01;
  const leftP = left * itemHeight * 0.01;
  const heightP = height * itemHeight * 0.01;
  const widthP = width * itemHeight * 0.01;

  const extraOffset = (top * itemHeight) / 100;

  return startOffset + extraOffset;
};
