import type { JSX } from "react";

import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";

export const CustomLayer = ({
  children,
}: {
  children: (pageNumber: number) => JSX.Element;
}) => {
  const pageNumber = usePDFPageNumber();

  return children(pageNumber);
};
