import type { HTMLProps, ReactNode } from "react";

import { PDFPageNumberContext } from "../hooks/usePdfPageNumber";
import { usePdf } from "../internal";
import { Primitive } from "./primitive";

export const Page = ({
  children,
  pageNumber = 1,
  style,
  ...props
}: HTMLProps<HTMLDivElement> & {
  children: ReactNode;
  pageNumber?: number;
}) => {
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));

  /**
   * When the PDF has some rotation, creating the div with width/height
   * dimensions directly from the "view" array attribute can lead
   * to incorrect rectangle, and so possible wrong layer positioning
   * (i.e., highlighting).
   * Instead, we have to use the width/height from the page viewport that are
   * build taking into consideration the possible PDF rotation
   */
  const viewports = usePdf((state) => state.viewports);
  let width:number;
  let height:number;

  const pageViewport = viewports[pageNumber];
  if(pageViewport) {
    width = pageViewport.width;
    height = pageViewport.height;
  } else {
    width = (pdfPageProxy.view[2] ?? 0) - (pdfPageProxy.view[0] ?? 0);
    height = (pdfPageProxy.view[3] ?? 0) - (pdfPageProxy.view[1] ?? 0);
  }

  return (
    <PDFPageNumberContext.Provider value={pdfPageProxy.pageNumber}>
      <Primitive.div
        style={{
          display: "block",
        }}
      >
        <div
          style={
            {
              ...style,
              "--scale-factor": 1,
              "--total-scale-factor": 1,
              position: "relative",
              width,
              height,
            } as React.CSSProperties
          }
          {...props}
        >
          {children}
        </div>
      </Primitive.div>
    </PDFPageNumberContext.Provider>
  );
};
