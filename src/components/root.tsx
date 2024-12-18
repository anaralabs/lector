import { forwardRef, type HTMLProps, type ReactNode } from "react";
import {
  usePDFDocumentContext,
  type usePDFDocumentParams,
} from "../hooks/document/document";
import { Primitive } from "./primitive";
import { PDFStore } from "../internal";

export const Root = forwardRef(
  (
    {
      children,
      fileURL,
      loader,
      onDocumentLoad,
      isZoomFitWidth,
      ...props
    }: HTMLProps<HTMLDivElement> &
      usePDFDocumentParams & {
        loader?: ReactNode;
      },
    ref,
  ) => {
    const { initialState } = usePDFDocumentContext({
      fileURL,
      onDocumentLoad,
      isZoomFitWidth,
    });

    return (
      <Primitive.div ref={ref} {...props}>
        {initialState ? (
          <PDFStore.Provider initialValue={initialState}>
            {children}
          </PDFStore.Provider>
        ) : (
          loader || "Loading..."
        )}
      </Primitive.div>
    );
  },
);
