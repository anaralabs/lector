import { type HTMLProps, useEffect, useRef, useState } from "react";

import { usePdfJump } from "../hooks/pages/usePdfJump";
import { usePdf } from "../internal";

export const NextPage = () => {};
export const PreviousPage = () => {};
export const CurrentPage = ({ ...props }: HTMLProps<HTMLInputElement>) => {
  const currentPage = usePdf((state) => state.currentPage);
  const pages = usePdf((state) => state.pdfDocumentProxy.numPages);

  const [pageNumber, setPageNumber] = useState<string | number>(currentPage);
  const isSelected = useRef<boolean>(false);

  const { jumpToPage } = usePdfJump();

  useEffect(() => {
    if (isSelected.current) {
      return;
    }
    setPageNumber(currentPage);
  }, [currentPage]);

  return (
    <input
      type="number"
      {...props}
      style={{
        ...props.style,
        appearance: "textfield",
        MozAppearance: "textfield",
        WebkitAppearance: "none",
      }}
      value={pageNumber}
      onChange={(e) => {
        setPageNumber(e.target.value);
      }}
      onClick={() => (isSelected.current = true)}
      onBlur={(e) => {
        if (currentPage !== Number(e.target.value)) {
          jumpToPage(Number(e.target.value), {
            behavior: "auto",
          });
        }

        isSelected.current = false;
      }}
      onKeyDown={(e) => {
        e.key === "Enter" && e.currentTarget.blur();
      }}
      min={1}
      max={pages}
    />
  );
};

export const TotalPages = ({ ...props }: HTMLProps<HTMLDivElement>) => {
  const pages = usePdf((state) => state.pdfDocumentProxy.numPages);

  return <div {...props}>{pages}</div>;
};
