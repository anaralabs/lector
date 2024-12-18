import { AnnotationLayer } from "pdfjs-dist";
import { useEffect, useRef } from "react";
import { useVisibility } from "../useVisibility";
import { usePdf } from "../../internal";
import { usePDFPageNumber } from "../usePdfPageNumber";
import { usePDFLinkService } from "../usePDFLinkService";
import { cancellable } from "../../lib/cancellable";

export interface AnnotationLayerParams {
  /**
   * Whether to render forms.
   */
  renderForms?: boolean;
}

const defaultAnnotationLayerParams = {
  renderForms: true,
} satisfies Required<AnnotationLayerParams>;

export const useAnnotationLayer = (params: AnnotationLayerParams) => {
  const annotationLayerRef = useRef<HTMLDivElement>(null);
  const annotationLayerObjectRef = useRef<AnnotationLayer | null>(null);
  const linkService = usePDFLinkService();
  const { visible } = useVisibility({
    elementRef: annotationLayerRef,
  });

  const pageNumber = usePDFPageNumber();
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));

  useEffect(() => {
    if (!annotationLayerRef.current) {
      return;
    }

    if (visible) {
      annotationLayerRef.current.style.contentVisibility = "visible";
    } else {
      annotationLayerRef.current.style.contentVisibility = "hidden";
    }
  }, [visible]);

  useEffect(() => {
    if (!annotationLayerRef.current) {
      return;
    }

    annotationLayerRef.current.innerHTML = "";

    const annotationLayerConfig = {
      div: annotationLayerRef.current,
      viewport: pdfPageProxy.getViewport({ scale: 1 }),
      page: pdfPageProxy,
      accessibilityManager: undefined,
      annotationCanvasMap: undefined,
      annotationEditorUIManager: undefined,
      structTreeLayer: undefined,
    };

    const annotationLayer = new AnnotationLayer(annotationLayerConfig);

    annotationLayerObjectRef.current = annotationLayer;

    const { cancel } = cancellable(
      (async () => {
        await annotationLayer.render({
          ...annotationLayerConfig,
          ...defaultAnnotationLayerParams,
          ...params,
          annotations: await pdfPageProxy.getAnnotations(),
          // @ts-expect-error TODO: Fix this
          linkService,
        });
      })(),
    );

    cancel();

    return () => {
      cancel();
    };
  }, [pdfPageProxy, annotationLayerRef.current]);

  return {
    annotationLayerRef,
  };
};
