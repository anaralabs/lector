import { AnnotationLayer } from "pdfjs-dist";
import { useEffect, useRef } from "react";

import { usePdf } from "../../internal";
import { cancellable } from "../../lib/cancellable";
import { usePdfJump } from "../pages/usePdfJump";
import { usePDFLinkService } from "../usePDFLinkService";
import { usePDFPageNumber } from "../usePdfPageNumber";
import { useVisibility } from "../useVisibility";

export interface AnnotationLayerParams {
  /**
   * Whether to render forms.
   */
  renderForms?: boolean;
  
  /**
   * Whether external links are enabled.
   * If false, external links will not open.
   * @default true
   */
  externalLinksEnabled?: boolean;
  
  /**
   * Options to pass to the jumpToPage function when navigating.
   * See usePdfJump hook for available options.
   * @default { behavior: "smooth", align: "start" }
   */
  jumpOptions?: Parameters<ReturnType<typeof usePdfJump>['jumpToPage']>[1];
}

const defaultAnnotationLayerParams = {
  renderForms: true,
  externalLinksEnabled: true,
  jumpOptions: { behavior: "smooth", align: "start" },
} satisfies Required<AnnotationLayerParams>;

export const useAnnotationLayer = (params: AnnotationLayerParams) => {
  const mergedParams = { ...defaultAnnotationLayerParams, ...params };
  const annotationLayerRef = useRef<HTMLDivElement>(null);
  const annotationLayerObjectRef = useRef<AnnotationLayer | null>(null);
  const linkService = usePDFLinkService();
  const { visible } = useVisibility({
    elementRef: annotationLayerRef,
  });

  const pageNumber = usePDFPageNumber();
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
  const pdfDocumentProxy = usePdf((state) => state.pdfDocumentProxy);
  
  // Apply external links setting to link service
  useEffect(() => {
    linkService.externalLinkEnabled = mergedParams.externalLinksEnabled;
  }, [linkService, mergedParams.externalLinksEnabled]);
  
  const { jumpToPage } = usePdfJump();
  
  // Connect the LinkService to the jumpToPage function to enable PDF navigation through links
  useEffect(() => {
    if (!jumpToPage) return;
    
    // Define a callback function to handle page navigation
    const handlePageNavigation = (pageNumber: number) => {
      jumpToPage(pageNumber, mergedParams.jumpOptions);
    };
    
    // Register our callback with the LinkService
    linkService.registerPageNavigationCallback(handlePageNavigation);
    
    // Clean up the callback when the component unmounts
    return () => {
      linkService.unregisterPageNavigationCallback();
    };
  }, [jumpToPage, linkService, mergedParams.jumpOptions]);

  // Add CSS for annotation layer
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      .annotationLayer {
        position: absolute;
        left: 0;
        top: 0;
        right: 0;
        bottom: 0;
        overflow: hidden;
        opacity: 1;
        z-index: 3;
      }
      
      .annotationLayer section {
        position: absolute;
      }
      
      .annotationLayer .linkAnnotation > a,
      .annotationLayer .buttonWidgetAnnotation.pushButton > a {
        position: absolute;
        font-size: 1em;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7") 0 0 repeat;
        cursor: pointer;
      }
      
      .annotationLayer .linkAnnotation > a:hover,
      .annotationLayer .buttonWidgetAnnotation.pushButton > a:hover {
        opacity: 0.2;
        background: rgba(255, 255, 0, 1);
        box-shadow: 0 2px 10px rgba(255, 255, 0, 1);
      }
    `;
    document.head.appendChild(style);
    
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Add event handler for link clicks
  useEffect(() => {
    if (!annotationLayerRef.current) return;
    
    const element = annotationLayerRef.current;
    
    // Handler for link clicks in the annotation layer
    const handleLinkClick = (e: MouseEvent) => {
      // Only handle links in annotation layer
      if (!e.target || !(e.target instanceof HTMLAnchorElement)) return;
      
      const target = e.target as HTMLAnchorElement;
      const href = target.getAttribute('href') || '';
      
      // Handle internal page links
      if (href.startsWith('#page=')) {
        e.preventDefault();
        const pageNumber = parseInt(href.substring(6), 10);
        if (!isNaN(pageNumber)) {
          linkService.goToPage(pageNumber);
        }
      }
      // External links will be handled by browser
    };
    
    element.addEventListener('click', handleLinkClick as EventListener);
    
    return () => {
      element.removeEventListener('click', handleLinkClick as EventListener);
    };
  }, [linkService]);

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
    if (!annotationLayerRef.current || !pdfPageProxy || !pdfDocumentProxy) {
      return;
    }

    // Update the pdfDocumentProxy in the linkService
    if (linkService._pdfDocumentProxy !== pdfDocumentProxy) {
      linkService.setDocument(pdfDocumentProxy);
    }

    // Clear the current layer
    annotationLayerRef.current.innerHTML = "";
    
    // Add necessary class for styling
    annotationLayerRef.current.className = 'annotationLayer';

    const viewport = pdfPageProxy.getViewport({ scale: 1 });
    
    const annotationLayerConfig = {
      div: annotationLayerRef.current,
      viewport: viewport,
      page: pdfPageProxy,
      linkService: linkService,
      accessibilityManager: undefined,
      annotationCanvasMap: undefined,
      annotationEditorUIManager: undefined,
      structTreeLayer: undefined,
    };

    const annotationLayer = new AnnotationLayer(annotationLayerConfig);
    annotationLayerObjectRef.current = annotationLayer;

    const { cancel } = cancellable(
      (async () => {
        try {
          const annotations = await pdfPageProxy.getAnnotations();
          
          await annotationLayer.render({
            ...annotationLayerConfig,
            ...mergedParams,
            annotations,
            linkService,
          });
          
        } catch (_error) {
          // Silently handle rendering errors
        }
      })(),
    );

    return () => {
      cancel();
    };
  }, [pdfPageProxy, pdfDocumentProxy, mergedParams, linkService]);

  return {
    annotationLayerRef,
  };
};
