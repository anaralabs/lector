'use client';

import React, { createContext, memo, forwardRef, useMemo, cloneElement, useEffect, useRef, useState, useCallback, useContext, useLayoutEffect, createRef, startTransition } from 'react';
import { createPortal } from 'react-dom';
import { useFloating, autoUpdate, offset, shift, useDismiss, useInteractions, inline, flip } from '@floating-ui/react';
import { create, useStore, createStore } from 'zustand';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { useDebounce } from 'use-debounce';
import { v4 } from 'uuid';
import { Slot } from '@radix-ui/react-slot';
import { useVirtualizer, elementScroll, debounce } from '@tanstack/react-virtual';

// src/lib/clamp.ts
var clamp = (value, minimum, maximum) => {
  return Math.min(Math.max(value, minimum), maximum);
};

// src/lib/zoom.ts
var getFitWidthZoom = (containerWidth, viewports, zoomOptions) => {
  const { minZoom, maxZoom } = zoomOptions;
  const maxPageWidth = Math.max(...viewports.map((viewport) => viewport.width));
  const targetZoom = containerWidth / maxPageWidth;
  const clampedZoom = Math.min(Math.max(targetZoom, minZoom), maxZoom);
  return clampedZoom;
};
var createZustandContext = (getStore) => {
  const Context = React.createContext(null);
  const Provider = (props) => {
    const [store] = React.useState(() => getStore(props.initialValue));
    return /* @__PURE__ */ jsx(Context.Provider, { value: store, children: props.children });
  };
  return {
    useContext: () => React.useContext(Context),
    Context,
    Provider
  };
};

// src/internal.ts
var PDFStore = createZustandContext(
  (initialState) => {
    return createStore((set, get) => ({
      pdfDocumentProxy: initialState.pdfDocumentProxy,
      zoom: initialState.zoom,
      isZoomFitWidth: initialState.isZoomFitWidth ?? false,
      zoomOptions: {
        minZoom: initialState.zoomOptions?.minZoom ?? 0.5,
        maxZoom: initialState.zoomOptions?.maxZoom ?? 10
      },
      viewportRef: createRef(),
      viewports: initialState.viewports,
      updateZoom: (zoom, isZoomFitWidth = false) => {
        const { minZoom, maxZoom } = get().zoomOptions;
        set((state) => {
          if (typeof zoom === "function") {
            const newZoom2 = clamp(zoom(state.zoom), minZoom, maxZoom);
            return { zoom: newZoom2, isZoomFitWidth };
          }
          const newZoom = clamp(zoom, minZoom, maxZoom);
          return { zoom: newZoom, isZoomFitWidth };
        });
      },
      zoomFitWidth: () => {
        const { viewportRef, zoomOptions, viewports } = get();
        if (!viewportRef.current) return;
        const clampedZoom = getFitWidthZoom(
          viewportRef.current.clientWidth,
          viewports,
          zoomOptions
        );
        set({
          zoom: clampedZoom,
          isZoomFitWidth: true
        });
        return clampedZoom;
      },
      currentPage: 1,
      setCurrentPage: (val) => {
        set({
          currentPage: val
        });
      },
      isPinching: false,
      setIsPinching: (val) => {
        set({
          isPinching: val
        });
      },
      virtualizer: null,
      setVirtualizer: (val) => {
        set({
          virtualizer: val
        });
      },
      pageProxies: initialState.pageProxies,
      getPdfPageProxy: (pageNumber) => {
        const proxy = get().pageProxies[pageNumber - 1];
        if (!proxy) throw new Error(`Page ${pageNumber} does not exist`);
        return proxy;
      },
      textContent: [],
      setTextContent: (val) => {
        set({
          textContent: val
        });
      },
      highlights: [],
      setHighlight: (val) => {
        set({
          highlights: val
        });
      },
      customSelectionRects: [],
      setCustomSelectionRects: (val) => {
        set({
          customSelectionRects: val
        });
      },
      coloredHighlights: [],
      addColoredHighlight: (value) => set((prevState) => ({
        coloredHighlights: [...prevState.coloredHighlights, value]
      })),
      deleteColoredHighlight: (uuid) => set((prevState) => ({
        coloredHighlights: prevState.coloredHighlights.filter(
          (rect) => rect.uuid !== uuid
        )
      })),
      renderedPages: {},
      markPageRendered: (pageNumber) => {
        const current = get().renderedPages;
        if (current[pageNumber]) return;
        set({ renderedPages: { ...current, [pageNumber]: true } });
      },
      unmarkPageRendered: (pageNumber) => {
        const current = get().renderedPages;
        if (!current[pageNumber]) return;
        const { [pageNumber]: _, ...rest } = current;
        set({ renderedPages: rest });
      }
    }));
  }
);
var usePdf = (selector) => useStore(PDFStore.useContext(), selector);
var usePdfStore = () => PDFStore.useContext();

// src/hooks/useAnnotationTooltip.ts
var useAnnotationTooltip = ({
  annotation,
  onOpenChange,
  position = "top",
  isOpen: controlledIsOpen
}) => {
  const isNewAnnotation = Date.now() - new Date(annotation.createdAt).getTime() < 1e3;
  const [isPositionCalculated, setIsPositionCalculated] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const viewportRef = usePdf((state) => state.viewportRef);
  const scale = usePdf((state) => state.zoom);
  const effectiveIsOpen = (isOpen && isPositionCalculated || controlledIsOpen) ?? false;
  const { refs, floatingStyles, context } = useFloating({
    placement: position,
    open: effectiveIsOpen,
    onOpenChange: (open) => {
      setIsOpen(open);
      onOpenChange?.(open);
    },
    whileElementsMounted: autoUpdate,
    middleware: [
      inline(),
      offset(10),
      flip({
        crossAxis: false,
        fallbackAxisSideDirection: "end"
      }),
      shift({ padding: 8 })
    ]
  });
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);
  const updateTooltipPosition = useCallback(() => {
    if (!annotation.highlights.length) {
      setIsPositionCalculated(false);
      return;
    }
    const highlightRects = annotation.highlights;
    let minLeft = Infinity;
    let maxRight = -Infinity;
    let minTop = Infinity;
    let maxBottom = -Infinity;
    const viewportElement = viewportRef.current;
    if (!viewportElement) {
      setIsPositionCalculated(false);
      return;
    }
    const pageElement = viewportElement.querySelector(
      `[data-page-number="${annotation.pageNumber}"]`
    );
    if (!pageElement) {
      setIsPositionCalculated(false);
      return;
    }
    refs.setReference({
      getBoundingClientRect() {
        const pageRect = pageElement.getBoundingClientRect();
        highlightRects.forEach((highlight) => {
          const scaledLeft = highlight.left * scale;
          const scaledWidth = highlight.width * scale;
          const scaledTop = highlight.top * scale;
          const scaledHeight = highlight.height * scale;
          const left = pageRect.left + scaledLeft;
          const right = left + scaledWidth;
          const top = pageRect.top + scaledTop;
          const bottom = top + scaledHeight;
          minLeft = Math.min(minLeft, left);
          maxRight = Math.max(maxRight, right);
          minTop = Math.min(minTop, top);
          maxBottom = Math.max(maxBottom, bottom);
        });
        const width = maxRight - minLeft;
        const height = maxBottom - minTop;
        const centerX = minLeft + width / 2;
        const centerY = minTop + height / 2;
        const rect = {
          width,
          height,
          x: centerX - width / 2,
          y: centerY - height / 2,
          top: centerY - height / 2,
          right: centerX + width / 2,
          bottom: centerY + height / 2,
          left: centerX - width / 2
        };
        return rect;
      },
      getClientRects() {
        return [this.getBoundingClientRect()];
      },
      contextElement: viewportRef.current || void 0
    });
    setIsPositionCalculated(true);
    if (isNewAnnotation) {
      setIsOpen(true);
    }
  }, [
    annotation.highlights,
    annotation.pageNumber,
    refs,
    viewportRef,
    scale,
    isNewAnnotation
  ]);
  useEffect(() => {
    const viewport = viewportRef.current;
    setIsPositionCalculated(false);
    requestAnimationFrame(() => {
      updateTooltipPosition();
    });
    const handleScroll = () => {
      requestAnimationFrame(updateTooltipPosition);
    };
    const handleResize = () => {
      requestAnimationFrame(updateTooltipPosition);
    };
    if (viewport) {
      viewport.addEventListener("scroll", handleScroll, {
        passive: true
      });
    }
    window.addEventListener("resize", handleResize, { passive: true });
    return () => {
      if (viewport) {
        viewport.removeEventListener("scroll", handleScroll);
      }
      window.removeEventListener("resize", handleResize);
    };
  }, [updateTooltipPosition, viewportRef]);
  return {
    isOpen: effectiveIsOpen,
    setIsOpen,
    refs,
    floatingStyles,
    getFloatingProps,
    getReferenceProps
  };
};
var AnnotationTooltip = ({
  annotation,
  children,
  renderTooltipContent,
  hoverTooltipContent,
  onOpenChange,
  className,
  focusedOpenId,
  focusedHoverOpenId,
  hoverClassName,
  isOpen: controlledIsOpen,
  hoverIsOpen: controlledHoverIsOpen
}) => {
  const viewportRef = usePdf((state) => state.viewportRef);
  const closeTimeoutRef = useRef(null);
  const isMouseInTooltipRef = useRef(false);
  const [triggeredPosition, setTriggeredPosition] = useState();
  const {
    isOpen: uncontrolledIsOpen,
    setIsOpen,
    refs,
    floatingStyles,
    getFloatingProps,
    getReferenceProps
  } = useAnnotationTooltip({
    annotation,
    onOpenChange,
    position: triggeredPosition,
    isOpen: controlledIsOpen
  });
  const {
    isOpen: uncontrolledHoverIsOpen,
    setIsOpen: setHoverIsOpen,
    refs: hoverRefs,
    floatingStyles: hoverFloatingStyles,
    getFloatingProps: getHoverFloatingProps,
    getReferenceProps: getHoverReferenceProps
  } = useAnnotationTooltip({
    position: "bottom",
    annotation,
    isOpen: controlledHoverIsOpen
  });
  const isOpen = controlledIsOpen ?? uncontrolledIsOpen;
  const hoverIsOpen = controlledHoverIsOpen || uncontrolledHoverIsOpen;
  const handleClick = useCallback(() => {
    if (controlledIsOpen === void 0) {
      setIsOpen(!isOpen);
    }
  }, [controlledIsOpen, isOpen, setIsOpen]);
  const handleMouseEnter = useCallback(() => {
    if (focusedOpenId && focusedOpenId !== annotation.id) return;
    if (focusedHoverOpenId && focusedHoverOpenId !== annotation.id) return;
    if (hoverTooltipContent) {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      setHoverIsOpen(true);
    }
  }, [
    hoverTooltipContent,
    setHoverIsOpen,
    annotation.id,
    focusedHoverOpenId,
    focusedOpenId
  ]);
  const closeTooltip = useCallback(() => {
    if (!isMouseInTooltipRef.current) {
      setHoverIsOpen(false);
    }
  }, [setHoverIsOpen]);
  const handleMouseLeave = useCallback(() => {
    if (!hoverTooltipContent) return;
    closeTimeoutRef.current = setTimeout(closeTooltip, 100);
  }, [hoverTooltipContent, closeTooltip]);
  const handleTooltipMouseEnter = useCallback(() => {
    if (focusedOpenId && focusedOpenId !== annotation.id) return;
    if (focusedHoverOpenId && focusedHoverOpenId !== annotation.id) return;
    isMouseInTooltipRef.current = true;
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, [annotation.id, focusedOpenId, focusedHoverOpenId]);
  const handleTooltipMouseLeave = useCallback(() => {
    isMouseInTooltipRef.current = false;
    setHoverIsOpen(false);
  }, [setHoverIsOpen]);
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      "div",
      {
        ref: (node) => {
          refs.setReference(node);
          hoverRefs.setReference(node);
        },
        onClick: handleClick,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
        ...getReferenceProps(),
        ...getHoverReferenceProps(),
        children
      }
    ),
    isOpen && viewportRef.current && createPortal(
      /* @__PURE__ */ jsx(
        "div",
        {
          ref: refs.setFloating,
          className,
          "data-annotation-tooltip": "click",
          style: {
            ...floatingStyles,
            position: "absolute",
            pointerEvents: "auto",
            zIndex: 50
          },
          ...getFloatingProps(),
          children: renderTooltipContent({
            annotation,
            onClose: () => setIsOpen(false),
            setPosition: (position) => setTriggeredPosition(position)
          })
        }
      ),
      viewportRef.current
    ),
    !isOpen && hoverIsOpen && annotation.comment && hoverTooltipContent && viewportRef.current && createPortal(
      /* @__PURE__ */ jsx(
        "div",
        {
          ref: hoverRefs.setFloating,
          className: hoverClassName,
          "data-annotation-tooltip": "hover",
          style: {
            ...hoverFloatingStyles,
            position: "absolute",
            pointerEvents: "auto",
            zIndex: 51
          },
          onMouseEnter: handleTooltipMouseEnter,
          onMouseLeave: handleTooltipMouseLeave,
          ...getHoverFloatingProps(),
          children: hoverTooltipContent
        }
      ),
      viewportRef.current
    )
  ] });
};
var useAnnotations = create((set) => ({
  annotations: [],
  addAnnotation: (annotation) => set((state) => ({
    annotations: [...state.annotations, annotation]
  })),
  updateAnnotation: (id, updates) => set((state) => ({
    annotations: state.annotations.map(
      (annotation) => annotation.id === id ? {
        ...annotation,
        ...updates
      } : annotation
    )
  })),
  deleteAnnotation: (id) => set((state) => ({
    annotations: state.annotations.filter(
      (annotation) => annotation.id !== id
    )
  })),
  setAnnotations: (annotations) => set({ annotations })
}));
var PDFPageNumberContext = createContext(0);
var usePDFPageNumber = () => {
  return useContext(PDFPageNumberContext);
};
var AnnotationHighlightLayer = ({
  className,
  style,
  renderTooltipContent,
  renderHoverTooltipContent,
  tooltipClassName,
  highlightClassName,
  underlineClassName,
  commentIconPosition,
  commmentIcon,
  commentIconClassName,
  focusedAnnotationId,
  focusedHoverAnnotationId,
  onAnnotationClick,
  onAnnotationTooltipClose,
  hoverTooltipClassName
}) => {
  const { annotations } = useAnnotations();
  const pageNumber = usePDFPageNumber();
  const isPageRendered = usePdf((state) => !!state.renderedPages[pageNumber]);
  const pageAnnotations = useMemo(
    () => annotations.filter((a) => a.pageNumber === pageNumber),
    [annotations, pageNumber]
  );
  if (!isPageRendered) return null;
  const getCommentIconPosition = (highlights) => {
    if (!highlights.length) return { top: 0, right: 10 };
    const sortedHighlights = highlights.toSorted((a, b) => {
      const topDiff = a.top - b.top;
      return Math.abs(topDiff) < 3 ? a.left - b.left : topDiff;
    });
    const lines = [];
    let currentLine = [];
    sortedHighlights.forEach((highlight) => {
      if (currentLine.length === 0) {
        currentLine.push(highlight);
      } else {
        const firstInLine = currentLine[0];
        if (Math.abs(highlight.top - firstInLine.top) <= 3) {
          currentLine.push(highlight);
        } else {
          lines.push([...currentLine]);
          currentLine = [highlight];
        }
      }
    });
    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
    const PAGE_WIDTH = 600;
    const hasLongLine = lines.some((line) => {
      if (line.length === 0) return false;
      const rightmost2 = Math.max(...line.map((h) => h.left + h.width));
      return rightmost2 > PAGE_WIDTH * 0.8;
    });
    const firstHighlight = highlights[0];
    const firstLine = lines[0] || [];
    const leftmost = Math.min(...firstLine.map((h) => h.left));
    const rightmost = Math.max(...firstLine.map((h) => h.left + h.width));
    const lineCenter = leftmost + (rightmost - leftmost) / 2;
    const shouldPositionRight = hasLongLine || lineCenter > PAGE_WIDTH * 0.5;
    const rightPosition = commentIconPosition === "highlight" ? { left: rightmost + 8 } : { right: 10 };
    const leftPosition = commentIconPosition === "highlight" ? { left: leftmost - 18 } : { left: 20 };
    return {
      top: firstHighlight.top + firstHighlight.height / 2 - 6,
      ...shouldPositionRight ? rightPosition : leftPosition
    };
  };
  return /* @__PURE__ */ jsx("div", { className, style, children: pageAnnotations.map((annotation) => {
    return /* @__PURE__ */ jsx(
      AnnotationTooltip,
      {
        annotation,
        className: tooltipClassName,
        hoverClassName: hoverTooltipClassName,
        focusedOpenId: focusedAnnotationId,
        focusedHoverOpenId: focusedHoverAnnotationId,
        isOpen: focusedAnnotationId === annotation.id,
        hoverIsOpen: focusedHoverAnnotationId === annotation.id,
        onOpenChange: (open) => {
          if (open && onAnnotationClick) {
            onAnnotationClick(annotation);
          } else if (!open && onAnnotationTooltipClose) {
            onAnnotationTooltipClose(annotation);
          }
        },
        renderTooltipContent,
        hoverTooltipContent: renderHoverTooltipContent({
          annotation,
          onClose: () => {
          }
        }),
        children: /* @__PURE__ */ jsxs(
          "div",
          {
            style: { cursor: "pointer" },
            onClick: () => onAnnotationClick?.(annotation),
            children: [
              annotation.highlights.map((highlight, index) => /* @__PURE__ */ jsx(
                "div",
                {
                  className: highlightClassName,
                  style: {
                    position: "absolute",
                    top: highlight.top,
                    left: highlight.left,
                    width: highlight.width,
                    height: highlight.height,
                    backgroundColor: annotation.color
                  },
                  "data-highlight-id": annotation.id
                },
                `highlight-${// biome-ignore lint/suspicious/noArrayIndexKey: <index>
                index}`
              )),
              annotation.comment && annotation.underlines?.map((rect, index) => /* @__PURE__ */ jsx(
                "div",
                {
                  className: underlineClassName,
                  style: {
                    position: "absolute",
                    top: rect.top,
                    left: rect.left,
                    width: rect.width,
                    height: 1.1,
                    backgroundColor: annotation.borderColor
                  },
                  "data-comment-id": annotation.id
                },
                `underline-${// biome-ignore lint/suspicious/noArrayIndexKey: <index>
                index}`
              )),
              annotation.comment && commmentIcon && /* @__PURE__ */ jsx(
                "div",
                {
                  className: commentIconClassName,
                  style: {
                    position: "absolute",
                    ...getCommentIconPosition(annotation.highlights),
                    color: "gray",
                    cursor: "pointer",
                    zIndex: 10
                  },
                  "data-comment-icon-id": annotation.id,
                  children: commmentIcon
                }
              )
            ]
          }
        )
      },
      annotation.id
    );
  }) });
};

// ../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
function r(e) {
  var t, f, n = "";
  if ("string" == typeof e || "number" == typeof e) n += e;
  else if ("object" == typeof e) if (Array.isArray(e)) {
    var o = e.length;
    for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
  } else for (f in e) e[f] && (n && (n += " "), n += f);
  return n;
}
function clsx() {
  for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
  return n;
}
var clsx_default = clsx;

// src/lib/annotation-layer-styles.ts
var ANNOTATION_LAYER_STYLE_ID = "lector-annotation-layer-styles";
var annotationLayerStyles = `
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
var ensureAnnotationLayerStyles = () => {
  if (typeof document === "undefined") {
    return;
  }
  if (document.getElementById(ANNOTATION_LAYER_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = ANNOTATION_LAYER_STYLE_ID;
  style.textContent = annotationLayerStyles;
  document.head.appendChild(style);
};
var usePdfJump = () => {
  const virtualizer = usePdf((state) => state.virtualizer);
  const setHighlight = usePdf((state) => state.setHighlight);
  const jumpToPage = useCallback(
    (pageIndex, options) => {
      if (!virtualizer) return;
      const defaultOptions = {
        align: "start",
        behavior: "smooth"
      };
      const finalOptions = { ...defaultOptions, ...options };
      virtualizer.scrollToIndex(pageIndex - 1, finalOptions);
    },
    [virtualizer]
  );
  const jumpToOffset = useCallback(
    (offset3) => {
      if (!virtualizer) return;
      virtualizer.scrollToOffset(offset3, {
        align: "start",
        behavior: "smooth"
      });
    },
    [virtualizer]
  );
  const scrollToHighlightRects = useCallback(
    (rects, type, align = "start", additionalOffset = 0) => {
      if (!virtualizer) return;
      const firstPage = Math.min(...rects.map((rect) => rect.pageNumber));
      const pageOffset = virtualizer.getOffsetForIndex(firstPage - 1, "start");
      if (pageOffset === null) return;
      const targetRect = rects.find((rect) => rect.pageNumber === firstPage);
      if (!targetRect) return;
      const isNumber = pageOffset?.[0] != null;
      if (!isNumber) return;
      const pageStart = pageOffset[0] ?? 0;
      let rectTop;
      let rectHeight;
      if (type === "percent") {
        const estimatePageHeight = virtualizer.options.estimateSize(
          firstPage - 1
        );
        rectTop = targetRect.top / 100 * estimatePageHeight;
        rectHeight = targetRect.height / 100 * estimatePageHeight;
      } else {
        rectTop = targetRect.top;
        rectHeight = targetRect.height;
      }
      let scrollOffset;
      if (align === "center") {
        const viewportHeight = virtualizer.scrollElement?.clientHeight || 0;
        const rectCenter = pageStart + rectTop + rectHeight / 2;
        scrollOffset = rectCenter - viewportHeight / 2;
      } else {
        scrollOffset = pageStart + rectTop;
      }
      scrollOffset += additionalOffset;
      const adjustedOffset = Math.max(0, scrollOffset);
      virtualizer.scrollToOffset(adjustedOffset, {
        align: "start",
        // Always use start when we've calculated our own centering
        behavior: "smooth"
      });
    },
    [virtualizer]
  );
  const jumpToHighlightRects = useCallback(
    (rects, type, align = "start", additionalOffset = 0) => {
      if (!virtualizer) return;
      setHighlight(rects);
      scrollToHighlightRects(rects, type, align, additionalOffset);
    },
    [virtualizer, setHighlight, scrollToHighlightRects]
  );
  return {
    jumpToPage,
    jumpToOffset,
    jumpToHighlightRects,
    scrollToHighlightRects
  };
};
var LinkService = class {
  _pdfDocumentProxy;
  externalLinkEnabled = true;
  isInPresentationMode = false;
  _currentPageNumber = 0;
  _pageNavigationCallback;
  get pdfDocumentProxy() {
    if (!this._pdfDocumentProxy) {
      throw new Error("pdfDocumentProxy is not set");
    }
    return this._pdfDocumentProxy;
  }
  get pagesCount() {
    return this._pdfDocumentProxy?.numPages || 0;
  }
  get page() {
    return this._currentPageNumber;
  }
  set page(value) {
    this._currentPageNumber = value;
    if (this._pageNavigationCallback) {
      this._pageNavigationCallback(value);
    }
  }
  // Required for link annotations to work
  setDocument(pdfDocument) {
    this._pdfDocumentProxy = pdfDocument;
  }
  setViewer() {
  }
  getDestinationHash(dest) {
    if (!dest) return "";
    const destRef = dest[0];
    if (dest.length > 1 && typeof dest[1] === "object" && dest[1] !== null && "url" in dest[1]) {
      const urlDest = dest[1];
      return urlDest.url;
    }
    if (destRef && typeof destRef === "object") {
      if ("num" in destRef) {
        const numRef = destRef;
        return `#page=${numRef.num + 1}`;
      }
      if ("gen" in destRef) {
        const genRef = destRef;
        const refNum = genRef.num ?? 0;
        return `#page=${refNum + 1}`;
      }
    }
    if (typeof destRef === "number") {
      return `#page=${destRef + 1}`;
    }
    return `#dest-${String(dest)}`;
  }
  getAnchorUrl(hash) {
    if (hash.startsWith("http://") || hash.startsWith("https://")) {
      return hash;
    }
    return `#${hash}`;
  }
  addLinkAttributes(link, url, newWindow) {
    if (!link) return;
    const isExternalLink = url.startsWith("http://") || url.startsWith("https://");
    if (isExternalLink && this.externalLinkEnabled) {
      link.href = url;
      link.target = newWindow === false ? "" : "_blank";
      link.rel = "noopener noreferrer";
    } else if (!isExternalLink) {
      link.href = url;
      link.target = "";
    } else {
      link.href = "#";
      link.target = "";
    }
  }
  async goToDestination(dest) {
    let explicitDest;
    if (typeof dest === "string") {
      explicitDest = await this.pdfDocumentProxy.getDestination(dest);
    } else if (Array.isArray(dest)) {
      explicitDest = dest;
    } else {
      explicitDest = await dest;
    }
    if (!explicitDest) {
      return;
    }
    if (explicitDest.length > 1 && typeof explicitDest[1] === "object" && explicitDest[1] !== null && "url" in explicitDest[1]) {
      return;
    }
    const destRef = explicitDest[0];
    let pageIndex;
    if (destRef && typeof destRef === "object") {
      if ("num" in destRef) {
        try {
          const refProxy = destRef;
          pageIndex = await this.pdfDocumentProxy.getPageIndex(refProxy);
        } catch (_error) {
          return;
        }
      } else {
        return;
      }
    } else if (typeof destRef === "number") {
      pageIndex = destRef;
    } else {
      return;
    }
    const pageNumber = pageIndex + 1;
    if (this._pageNavigationCallback) {
      this._pageNavigationCallback(pageNumber);
    }
  }
  executeNamedAction() {
  }
  navigateTo(dest) {
    this.goToDestination(dest);
  }
  get rotation() {
    return 0;
  }
  set rotation(_value) {
  }
  goToPage(_page_valuer) {
  }
  setHash(hash) {
    if (hash.startsWith("#page=")) {
      const pageNumber = parseInt(hash.substring(6), 10);
      if (!Number.isNaN(pageNumber)) {
        this.goToPage(pageNumber);
      }
    }
  }
  executeSetOCGState() {
  }
  // Method to register navigation callback
  registerPageNavigationCallback(callback) {
    this._pageNavigationCallback = callback;
  }
  // Method to unregister navigation callback
  unregisterPageNavigationCallback() {
    this._pageNavigationCallback = void 0;
  }
};
var useCreatePDFLinkService = (pdfDocumentProxy) => {
  const linkService = useRef(new LinkService());
  useEffect(() => {
    if (pdfDocumentProxy) {
      linkService.current._pdfDocumentProxy = pdfDocumentProxy;
      linkService.current.setDocument(pdfDocumentProxy);
    }
  }, [pdfDocumentProxy]);
  return linkService.current;
};
var defaultLinkService = new LinkService();
var PDFLinkServiceContext = createContext(defaultLinkService);
var usePDFLinkService = () => {
  return useContext(PDFLinkServiceContext);
};
var useVisibility = ({
  elementRef
}) => {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!elementRef.current) {
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry?.isIntersecting ?? false);
    });
    observer.observe(elementRef.current);
    return () => {
      observer.disconnect();
    };
  }, [elementRef]);
  return { visible };
};

// src/hooks/layers/useAnnotationLayer.tsx
var defaultAnnotationLayerParams = {
  renderForms: true,
  externalLinksEnabled: true,
  jumpOptions: { behavior: "smooth", align: "start" }
};
var useAnnotationLayer = (params) => {
  const mergedParams = useMemo(() => {
    return { ...defaultAnnotationLayerParams, ...params };
  }, [params]);
  const annotationLayerRef = useRef(null);
  const annotationLayerObjectRef = useRef(null);
  const linkService = usePDFLinkService();
  const { visible } = useVisibility({
    elementRef: annotationLayerRef
  });
  const pageNumber = usePDFPageNumber();
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
  const pdfDocumentProxy = usePdf((state) => state.pdfDocumentProxy);
  useEffect(() => {
    linkService.externalLinkEnabled = mergedParams.externalLinksEnabled;
  }, [linkService, mergedParams.externalLinksEnabled]);
  const { jumpToPage } = usePdfJump();
  useEffect(() => {
    if (!jumpToPage) return;
    const handlePageNavigation = (pageNumber2) => {
      jumpToPage(pageNumber2, mergedParams.jumpOptions);
    };
    linkService.registerPageNavigationCallback(handlePageNavigation);
    return () => {
      linkService.unregisterPageNavigationCallback();
    };
  }, [jumpToPage, linkService, mergedParams.jumpOptions]);
  useEffect(() => {
    ensureAnnotationLayerStyles();
  }, []);
  useEffect(() => {
    if (!annotationLayerRef.current) return;
    const element = annotationLayerRef.current;
    const handleLinkClick = (e) => {
      if (!e.target || !(e.target instanceof HTMLAnchorElement)) return;
      const target = e.target;
      const href = target.getAttribute("href") || "";
      if (href.startsWith("#page=")) {
        e.preventDefault();
        const pageNumber2 = parseInt(href.substring(6), 10);
        if (!Number.isNaN(pageNumber2)) {
          linkService.goToPage(pageNumber2);
        }
      }
    };
    element.addEventListener("click", handleLinkClick);
    return () => {
      element.removeEventListener("click", handleLinkClick);
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
    if (linkService._pdfDocumentProxy !== pdfDocumentProxy) {
      linkService.setDocument(pdfDocumentProxy);
    }
    const container = annotationLayerRef.current;
    let cancelled = false;
    container.replaceChildren();
    container.className = "annotationLayer";
    const viewport = pdfPageProxy.getViewport({ scale: 1 }).clone({
      dontFlip: true
    });
    const annotationLayerConfig = {
      div: container,
      viewport,
      page: pdfPageProxy,
      linkService,
      annotationStorage: void 0,
      accessibilityManager: void 0,
      annotationCanvasMap: void 0,
      annotationEditorUIManager: void 0,
      structTreeLayer: void 0,
      commentManager: void 0
    };
    (async () => {
      try {
        if (cancelled) return;
        const { AnnotationLayer: AnnotationLayer2 } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        if (cancelled) return;
        const annotationLayer = new AnnotationLayer2(annotationLayerConfig);
        annotationLayerObjectRef.current = annotationLayer;
        const annotations = await pdfPageProxy.getAnnotations();
        if (cancelled) return;
        await annotationLayer.render({
          ...annotationLayerConfig,
          ...mergedParams,
          annotations,
          linkService
        });
      } catch (_error) {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfPageProxy, pdfDocumentProxy, mergedParams, linkService]);
  return {
    annotationLayerRef
  };
};
var AnnotationLayer = memo(
  ({
    renderForms = true,
    externalLinksEnabled = true,
    jumpOptions = { behavior: "smooth", align: "start" },
    className,
    style,
    ...props
  }) => {
    const { annotationLayerRef } = useAnnotationLayer({
      renderForms,
      externalLinksEnabled,
      jumpOptions
    });
    return /* @__PURE__ */ jsx(
      "div",
      {
        className: clsx_default("annotationLayer", className),
        style: {
          ...style,
          position: "absolute",
          top: 0,
          left: 0
        },
        ...props,
        ref: annotationLayerRef
      }
    );
  }
);
AnnotationLayer.displayName = "AnnotationLayer";

// src/lib/canvas-utils.ts
var MAX_CANVAS_PIXELS = 16777216;
var MAX_CANVAS_DIMENSION = 32767;
function clampScaleForPage(targetScale, pageWidth, pageHeight) {
  if (!targetScale) {
    return 0;
  }
  const areaLimit = Math.sqrt(
    MAX_CANVAS_PIXELS / Math.max(pageWidth * pageHeight, 1)
  );
  const widthLimit = MAX_CANVAS_DIMENSION / Math.max(pageWidth, 1);
  const heightLimit = MAX_CANVAS_DIMENSION / Math.max(pageHeight, 1);
  const safeScale = Math.min(
    targetScale,
    Number.isFinite(areaLimit) ? areaLimit : targetScale,
    Number.isFinite(widthLimit) ? widthLimit : targetScale,
    Number.isFinite(heightLimit) ? heightLimit : targetScale
  );
  return Math.max(safeScale, 0);
}

// src/lib/scroll-activity.ts
var lastScrollAt = 0;
function notifyScrollActivity() {
  lastScrollAt = typeof performance !== "undefined" ? performance.now() : Date.now();
}
function msSinceScroll() {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return now - lastScrollAt;
}
var useDpr = () => {
  const [dpr, setDPR] = useState(
    typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio, 2)
  );
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleDPRChange = () => {
      setDPR(Math.min(window.devicePixelRatio, 2));
    };
    const windowMatch = window.matchMedia(
      `screen and (min-resolution: ${dpr}dppx)`
    );
    windowMatch.addEventListener("change", handleDPRChange);
    return () => {
      windowMatch.removeEventListener("change", handleDPRChange);
    };
  }, [dpr]);
  return dpr;
};

// src/hooks/layers/useCanvasLayer.tsx
var CACHE_MAX = 60;
var cacheEntries = [];
var canvasBitmapCache = /* @__PURE__ */ new WeakMap();
var supportsOffscreenCanvas = typeof OffscreenCanvas !== "undefined" && // Some older browsers expose OffscreenCanvas but not a 2d context on it.
(() => {
  try {
    const off = new OffscreenCanvas(1, 1);
    return !!off.getContext("2d");
  } catch {
    return false;
  }
})();
var idle = typeof requestIdleCallback !== "undefined" ? (fn) => requestIdleCallback(fn, { timeout: 500 }) : (fn) => setTimeout(fn, 0);
var cancelIdle = typeof cancelIdleCallback !== "undefined" ? (id) => cancelIdleCallback(id) : (id) => clearTimeout(id);
function clearBitmapCache(documentId) {
  if (documentId === void 0) {
    for (const entry of cacheEntries) {
      entry.bitmap.close();
      canvasBitmapCache.get(entry.proxy)?.delete(entry.key);
    }
    cacheEntries.length = 0;
    return;
  }
  for (let i = cacheEntries.length - 1; i >= 0; i--) {
    const entry = cacheEntries[i];
    if (entry.docId !== documentId) continue;
    entry.bitmap.close();
    canvasBitmapCache.get(entry.proxy)?.delete(entry.key);
    cacheEntries.splice(i, 1);
  }
}
function cacheKey(scale, background) {
  const quantScale = Math.round(scale * 100) / 100;
  const bg = background ?? "white";
  let hash = Math.round(quantScale * 1e4);
  for (let i = 0; i < bg.length; i++) {
    hash = hash * 31 + bg.charCodeAt(i) | 0;
  }
  return hash;
}
function getCachedBitmap(proxy, scale, background) {
  const key = cacheKey(scale, background);
  const bitmap = canvasBitmapCache.get(proxy)?.get(key);
  if (!bitmap) return null;
  const idx = cacheEntries.findIndex((e) => e.proxy === proxy && e.key === key);
  if (idx !== -1 && idx !== cacheEntries.length - 1) {
    const [entry] = cacheEntries.splice(idx, 1);
    cacheEntries.push(entry);
  }
  return bitmap;
}
function setCachedBitmap(docId, proxy, scale, background, bitmap) {
  const key = cacheKey(scale, background);
  let map = canvasBitmapCache.get(proxy);
  if (!map) {
    map = /* @__PURE__ */ new Map();
    canvasBitmapCache.set(proxy, map);
  }
  const existing = map.get(key);
  if (existing && existing !== bitmap) {
    existing.close();
    const idx = cacheEntries.findIndex(
      (e) => e.proxy === proxy && e.key === key
    );
    if (idx !== -1) cacheEntries.splice(idx, 1);
  }
  map.set(key, bitmap);
  cacheEntries.push({ docId, proxy, key, bitmap });
  while (cacheEntries.length > CACHE_MAX) {
    const evicted = cacheEntries.shift();
    const evictedMap = canvasBitmapCache.get(evicted.proxy);
    if (evictedMap?.get(evicted.key) === evicted.bitmap) {
      evictedMap.delete(evicted.key);
      evicted.bitmap.close();
    }
  }
}
function stagger(distanceFromCurrent) {
  if (distanceFromCurrent <= 1) return 0;
  return Math.min(distanceFromCurrent * 20, 160);
}
var useCanvasLayer = ({ background }) => {
  const canvasRef = useRef(null);
  const pageNumber = usePDFPageNumber();
  const dpr = useDpr();
  const bouncyZoom = usePdf((state) => state.zoom);
  const docId = usePdf((state) => state.pdfDocumentProxy.fingerprints[0] ?? "");
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
  const markPageRendered = usePdf((state) => state.markPageRendered);
  const unmarkPageRendered = usePdf((state) => state.unmarkPageRendered);
  const currentPage = usePdf((state) => state.currentPage);
  const [zoom] = useDebounce(bouncyZoom, 100);
  const lastCommittedRef = useRef(null);
  useLayoutEffect(() => {
    if (!canvasRef.current) return;
    const baseCanvas = canvasRef.current;
    const baseViewport = pdfPageProxy.getViewport({ scale: 1 });
    const pageWidth = baseViewport.width;
    const pageHeight = baseViewport.height;
    const targetBaseScale = dpr * Math.min(zoom, 1);
    const baseScale = clampScaleForPage(targetBaseScale, pageWidth, pageHeight);
    const targetW = Math.floor(pageWidth * baseScale);
    const targetH = Math.floor(pageHeight * baseScale);
    const applyDimsIfNeeded = () => {
      if (lastCommittedRef.current?.w !== targetW || lastCommittedRef.current?.h !== targetH) {
        baseCanvas.width = targetW;
        baseCanvas.height = targetH;
        lastCommittedRef.current = { w: targetW, h: targetH };
      }
    };
    baseCanvas.style.position = "absolute";
    baseCanvas.style.top = "0";
    baseCanvas.style.left = "0";
    baseCanvas.style.width = `${pageWidth}px`;
    baseCanvas.style.height = `${pageHeight}px`;
    baseCanvas.style.transform = "translate(0px, 0px)";
    baseCanvas.style.zIndex = "0";
    baseCanvas.style.pointerEvents = "none";
    baseCanvas.style.backgroundColor = background ?? "white";
    const ctx = baseCanvas.getContext("2d");
    if (!ctx) return;
    const cached = getCachedBitmap(pdfPageProxy, baseScale, background);
    if (cached) {
      applyDimsIfNeeded();
      ctx.drawImage(cached, 0, 0);
      markPageRendered(pageNumber);
      return;
    }
    let cancelled = false;
    let renderingTask = null;
    let startTimeoutId = null;
    let idleHandle = null;
    const start = () => {
      if (cancelled) return;
      const viewport = pdfPageProxy.getViewport({ scale: baseScale });
      if (supportsOffscreenCanvas) {
        const off = new OffscreenCanvas(targetW, targetH);
        const offCtx = off.getContext("2d");
        if (!offCtx) return;
        renderingTask = pdfPageProxy.render({
          // pdfjs types require HTMLCanvasElement + CanvasRenderingContext2D
          // but accept OffscreenCanvas + OffscreenCanvasRenderingContext2D
          // at runtime. Cast keeps the .d.ts clean.
          canvas: off,
          canvasContext: offCtx,
          viewport,
          background
        });
        renderingTask.promise.then(() => {
          if (cancelled) return;
          const bitmap = off.transferToImageBitmap();
          applyDimsIfNeeded();
          ctx.drawImage(bitmap, 0, 0);
          markPageRendered(pageNumber);
          setCachedBitmap(
            docId,
            pdfPageProxy,
            baseScale,
            background,
            bitmap
          );
        }).catch((error) => {
          if (cancelled) return;
          if (error?.name === "RenderingCancelledException") return;
          console.error("PDF render error:", error);
        });
        return;
      }
      applyDimsIfNeeded();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderingTask = pdfPageProxy.render({
        canvas: baseCanvas,
        canvasContext: ctx,
        viewport,
        background
      });
      renderingTask.promise.then(() => {
        if (cancelled) return;
        markPageRendered(pageNumber);
        if (typeof createImageBitmap === "undefined") return;
        idleHandle = idle(() => {
          idleHandle = null;
          if (cancelled) return;
          createImageBitmap(baseCanvas).then((bitmap) => {
            if (cancelled) {
              bitmap.close();
              return;
            }
            setCachedBitmap(
              docId,
              pdfPageProxy,
              baseScale,
              background,
              bitmap
            );
          }).catch(() => {
          });
        });
      }).catch((error) => {
        if (cancelled) return;
        if (error?.name === "RenderingCancelledException") return;
        console.error("PDF render error:", error);
      });
    };
    const SCROLL_IDLE_MS = 120;
    const staggerDelay = stagger(
      Math.abs(pageNumber - (currentPage || pageNumber))
    );
    const attemptStart = () => {
      if (cancelled) return;
      const sinceScroll = msSinceScroll();
      if (sinceScroll < SCROLL_IDLE_MS) {
        startTimeoutId = setTimeout(
          attemptStart,
          SCROLL_IDLE_MS - sinceScroll
        );
        return;
      }
      startTimeoutId = null;
      start();
    };
    if (staggerDelay === 0) {
      attemptStart();
    } else {
      startTimeoutId = setTimeout(attemptStart, staggerDelay);
    }
    return () => {
      cancelled = true;
      if (startTimeoutId !== null) {
        clearTimeout(startTimeoutId);
        startTimeoutId = null;
      }
      if (idleHandle !== null) {
        cancelIdle(idleHandle);
        idleHandle = null;
      }
      void renderingTask?.cancel();
    };
  }, [
    pdfPageProxy,
    background,
    dpr,
    zoom,
    pageNumber,
    markPageRendered,
    docId
    // currentPage only affects the initial stagger delay. Changes to
    // it while we're already rendering shouldn't cancel the render, so
    // we intentionally snapshot it via the closure above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ]);
  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      unmarkPageRendered(pageNumber);
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      lastCommittedRef.current = null;
    };
  }, [pageNumber, unmarkPageRendered]);
  return {
    canvasRef
  };
};

// src/lib/viewport-invalidation.ts
var viewportInvalidationRegistry = /* @__PURE__ */ new WeakMap();
var notifyCallbacks = (entry) => {
  entry.rafId = null;
  entry.callbacks.forEach((callback) => {
    callback();
  });
};
var scheduleInvalidation = (entry) => {
  if (entry.rafId !== null) {
    return;
  }
  entry.rafId = requestAnimationFrame(() => {
    notifyCallbacks(entry);
  });
};
var subscribeToViewportInvalidation = (viewport, callback) => {
  let entry = viewportInvalidationRegistry.get(viewport);
  if (!entry) {
    const callbacks = /* @__PURE__ */ new Set();
    const schedule = () => {
      const currentEntry = viewportInvalidationRegistry.get(viewport);
      if (!currentEntry) {
        return;
      }
      scheduleInvalidation(currentEntry);
    };
    entry = {
      callbacks,
      scrollListener: schedule,
      windowResizeListener: schedule,
      resizeObserver: typeof ResizeObserver === "undefined" ? void 0 : new ResizeObserver(schedule),
      rafId: null
    };
    viewport.addEventListener("scroll", entry.scrollListener, {
      passive: true
    });
    window.addEventListener("resize", entry.windowResizeListener, {
      passive: true
    });
    entry.resizeObserver?.observe(viewport);
    viewportInvalidationRegistry.set(viewport, entry);
  }
  entry.callbacks.add(callback);
  return () => {
    const currentEntry = viewportInvalidationRegistry.get(viewport);
    if (!currentEntry) {
      return;
    }
    currentEntry.callbacks.delete(callback);
    if (currentEntry.callbacks.size > 0) {
      return;
    }
    if (currentEntry.rafId !== null) {
      cancelAnimationFrame(currentEntry.rafId);
    }
    viewport.removeEventListener("scroll", currentEntry.scrollListener);
    window.removeEventListener("resize", currentEntry.windowResizeListener);
    currentEntry.resizeObserver?.disconnect();
    viewportInvalidationRegistry.delete(viewport);
  };
};

// src/hooks/layers/useDetailCanvasLayer.tsx
var DETAIL_RENDER_IDLE_MS = 80;
var supportsOffscreenCanvas2 = typeof OffscreenCanvas !== "undefined" && (() => {
  try {
    const off = new OffscreenCanvas(1, 1);
    return !!off.getContext("2d");
  } catch {
    return false;
  }
})();
var supportsBitmapRenderer = typeof document !== "undefined" && (() => {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("bitmaprenderer");
  } catch {
    return false;
  }
})();
var supportsGpuDetailHandoff = supportsOffscreenCanvas2 && supportsBitmapRenderer;
var useDetailCanvasLayer = ({
  background,
  baseCanvasRef
}) => {
  const containerRef = useRef(null);
  const detailCanvasRef = useRef(null);
  const pageNumber = usePDFPageNumber();
  const dpr = useDpr();
  const bouncyZoom = usePdf((state) => state.zoom);
  const isPinching = usePdf((state) => state.isPinching);
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
  const viewportRef = usePdf((state) => state.viewportRef);
  const [zoom] = useDebounce(bouncyZoom, 200);
  const pageDimsRef = useRef(null);
  if (!pageDimsRef.current || pageDimsRef.current.proxy !== pdfPageProxy) {
    const vp = pdfPageProxy.getViewport({ scale: 1 });
    pageDimsRef.current = {
      width: vp.width,
      height: vp.height,
      proxy: pdfPageProxy
    };
  }
  const detailCtxRef = useRef(null);
  const getDetailCtx = () => {
    if (detailCtxRef.current) return detailCtxRef.current;
    const canvas = detailCanvasRef.current;
    if (!canvas) return null;
    if (supportsGpuDetailHandoff) {
      const ctx2 = canvas.getContext("bitmaprenderer");
      if (ctx2) {
        detailCtxRef.current = { kind: "gpu", ctx: ctx2 };
        return detailCtxRef.current;
      }
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    detailCtxRef.current = { kind: "2d", ctx };
    return detailCtxRef.current;
  };
  useLayoutEffect(() => {
    const scrollContainer = viewportRef?.current;
    if (!scrollContainer) {
      return;
    }
    const detailCanvas = detailCanvasRef.current;
    const container = containerRef.current;
    if (!detailCanvas || !container) {
      return;
    }
    let renderingTask = null;
    let renderTimeoutId = null;
    const bgColor = background ?? "white";
    const detailBaseStyle = `position:absolute;top:0;left:0;pointer-events:none;z-index:1;background-color:${bgColor}`;
    const hideDetailCanvas = () => {
      renderingTask?.cancel();
      detailCanvas.style.cssText = `${detailBaseStyle};display:block;opacity:0`;
      container.style.cssText = "";
    };
    const renderDetailCanvas = () => {
      const pageContainer = baseCanvasRef.current?.parentElement ?? null;
      if (!pageContainer) {
        hideDetailCanvas();
        return;
      }
      const { width: pageWidth, height: pageHeight } = pageDimsRef.current;
      const scrollX = scrollContainer.scrollLeft / zoom;
      const scrollY = scrollContainer.scrollTop / zoom;
      const viewportWidth = scrollContainer.clientWidth / zoom;
      const viewportHeight = scrollContainer.clientHeight / zoom;
      const pageRect = pageContainer.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const pageLeft = (pageRect.left - containerRect.left) / zoom + scrollX;
      const pageTop = (pageRect.top - containerRect.top) / zoom + scrollY;
      const visibleLeft = Math.max(0, scrollX - pageLeft);
      const visibleTop = Math.max(0, scrollY - pageTop);
      const visibleRight = Math.min(
        pageWidth,
        scrollX + viewportWidth - pageLeft
      );
      const visibleBottom = Math.min(
        pageHeight,
        scrollY + viewportHeight - pageTop
      );
      const visibleWidth = Math.max(0, visibleRight - visibleLeft);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      const targetDetailScale = dpr * zoom * 1.3;
      const baseTargetScale = dpr * Math.min(zoom, 1);
      const baseScale = clampScaleForPage(
        baseTargetScale,
        pageWidth,
        pageHeight
      );
      const needsDetail = zoom > 1 && targetDetailScale - baseScale > 1e-3;
      if (isPinching || !needsDetail || visibleWidth <= 0 || visibleHeight <= 0) {
        hideDetailCanvas();
        return;
      }
      renderingTask?.cancel();
      const pdfOffsetX = visibleLeft;
      const pdfOffsetY = visibleTop;
      const effectiveScale = targetDetailScale;
      const actualWidth = visibleWidth * effectiveScale;
      const actualHeight = visibleHeight * effectiveScale;
      const transform = [
        1,
        0,
        0,
        1,
        -pdfOffsetX * effectiveScale,
        -pdfOffsetY * effectiveScale
      ];
      const detailViewport = pdfPageProxy.getViewport({
        scale: effectiveScale
      });
      const ctxHandle = getDetailCtx();
      if (!ctxHandle) return;
      if (ctxHandle.kind === "gpu") {
        const off = new OffscreenCanvas(actualWidth, actualHeight);
        const offCtx = off.getContext("2d");
        if (!offCtx) return;
        offCtx.setTransform(1, 0, 0, 1, 0, 0);
        const currentRenderingTask2 = pdfPageProxy.render({
          // pdfjs accepts OffscreenCanvas at runtime even though the
          // types declare HTMLCanvasElement + CanvasRenderingContext2D.
          canvas: off,
          canvasContext: offCtx,
          viewport: detailViewport,
          background,
          transform
        });
        renderingTask = currentRenderingTask2;
        currentRenderingTask2.promise.then(() => {
          if (renderingTask !== currentRenderingTask2) return;
          const bitmap = off.transferToImageBitmap();
          detailCanvas.width = actualWidth;
          detailCanvas.height = actualHeight;
          detailCanvas.style.cssText = `${detailBaseStyle};display:block;opacity:1;width:${visibleWidth * zoom}px;height:${visibleHeight * zoom}px;transform-origin:center center;transform:translate(${visibleLeft * zoom}px,${visibleTop * zoom}px)`;
          container.style.cssText = `transform:scale3d(${1 / zoom},${1 / zoom},1);transform-origin:0 0`;
          ctxHandle.ctx.transferFromImageBitmap(bitmap);
        }).catch((error) => {
          if (error.name === "RenderingCancelledException") return;
          throw error;
        }).finally(() => {
          if (renderingTask === currentRenderingTask2) {
            renderingTask = null;
          }
        });
        return;
      }
      const buffer = document.createElement("canvas");
      buffer.width = actualWidth;
      buffer.height = actualHeight;
      const bufferCtx = buffer.getContext("2d");
      if (!bufferCtx) return;
      bufferCtx.setTransform(1, 0, 0, 1, 0, 0);
      const currentRenderingTask = pdfPageProxy.render({
        canvas: buffer,
        canvasContext: bufferCtx,
        viewport: detailViewport,
        background,
        transform
      });
      renderingTask = currentRenderingTask;
      currentRenderingTask.promise.then(() => {
        if (renderingTask !== currentRenderingTask) return;
        detailCanvas.width = actualWidth;
        detailCanvas.height = actualHeight;
        detailCanvas.style.cssText = `${detailBaseStyle};display:block;opacity:1;width:${visibleWidth * zoom}px;height:${visibleHeight * zoom}px;transform-origin:center center;transform:translate(${visibleLeft * zoom}px,${visibleTop * zoom}px)`;
        container.style.cssText = `transform:scale3d(${1 / zoom},${1 / zoom},1);transform-origin:0 0`;
        ctxHandle.ctx.drawImage(buffer, 0, 0);
      }).catch((error) => {
        if (error.name === "RenderingCancelledException") return;
        throw error;
      }).finally(() => {
        if (renderingTask === currentRenderingTask) {
          renderingTask = null;
        }
        buffer.width = 0;
        buffer.height = 0;
      });
    };
    const scheduleRender = (delay = DETAIL_RENDER_IDLE_MS) => {
      if (renderTimeoutId !== null) {
        clearTimeout(renderTimeoutId);
      }
      renderingTask?.cancel();
      renderTimeoutId = setTimeout(() => {
        renderTimeoutId = null;
        renderDetailCanvas();
      }, delay);
    };
    const needsInvalidationSubscription = zoom > 1 && !isPinching;
    const unsubscribe = needsInvalidationSubscription ? subscribeToViewportInvalidation(scrollContainer, scheduleRender) : null;
    if (zoom <= 1 || isPinching) {
      hideDetailCanvas();
    } else {
      scheduleRender(0);
    }
    return () => {
      unsubscribe?.();
      if (renderTimeoutId !== null) {
        clearTimeout(renderTimeoutId);
      }
      void renderingTask?.cancel();
    };
  }, [
    pdfPageProxy,
    zoom,
    isPinching,
    background,
    dpr,
    viewportRef,
    baseCanvasRef
  ]);
  useEffect(() => {
    const canvas = detailCanvasRef.current;
    return () => {
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
      detailCtxRef.current = null;
    };
  }, []);
  return {
    detailCanvasRef,
    containerRef
  };
};
var CanvasLayer = memo(
  ({
    style,
    background,
    ...props
  }) => {
    const { canvasRef } = useCanvasLayer({ background });
    const { detailCanvasRef, containerRef } = useDetailCanvasLayer({
      background,
      baseCanvasRef: canvasRef
    });
    return /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("canvas", { ...props, ref: canvasRef, style }),
      /* @__PURE__ */ jsx(
        "div",
        {
          ref: containerRef,
          className: "absolute top-0 left-0 w-full h-full flex items-center justify-center",
          children: /* @__PURE__ */ jsx("canvas", { ref: detailCanvasRef })
        }
      )
    ] });
  }
);
CanvasLayer.displayName = "CanvasLayer";

// src/hooks/useSelectionDimensions.tsx
var MERGE_THRESHOLD = 2;
var shouldMergeRects = (rect1, rect2) => {
  const verticalOverlap = !(rect1.top > rect2.top + rect2.height || rect2.top > rect1.top + rect1.height);
  const horizontallyConnected = Math.abs(rect1.left + rect1.width - rect2.left) <= MERGE_THRESHOLD || Math.abs(rect2.left + rect2.width - rect1.left) <= MERGE_THRESHOLD || rect1.left < rect2.left + rect2.width && rect2.left < rect1.left + rect1.width;
  return verticalOverlap && horizontallyConnected;
};
var consolidateHighlightRects = (rects) => {
  if (rects.length <= 1) return rects;
  const consolidated = [];
  const sorted = [...rects].sort((a, b) => {
    const pageCompare = a.pageNumber - b.pageNumber;
    if (pageCompare !== 0) return pageCompare;
    const topDiff = a.top - b.top;
    return Math.abs(topDiff) < 2 ? a.left - b.left : topDiff;
  });
  let current = sorted[0];
  if (!current) return rects;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (!next) continue;
    const samePageAndLine = current.pageNumber === next.pageNumber && Math.abs(current.top - next.top) < Math.max(current.height, next.height) * 0.5;
    const horizontallyConnected = samePageAndLine && // Adjacent (touching or very close)
    (Math.abs(current.left + current.width - next.left) <= MERGE_THRESHOLD || Math.abs(next.left + next.width - current.left) <= MERGE_THRESHOLD || // Overlapping
    current.left < next.left + next.width && next.left < current.left + current.width || // Very close (small gap)
    Math.abs(current.left + current.width - next.left) <= current.height * 0.2);
    if (horizontallyConnected) {
      const newLeft = Math.min(current.left, next.left);
      const newRight = Math.max(
        current.left + current.width,
        next.left + next.width
      );
      const newTop = Math.min(current.top, next.top);
      const newBottom = Math.max(
        current.top + current.height,
        next.top + next.height
      );
      current = {
        left: newLeft,
        top: newTop,
        width: newRight - newLeft,
        height: newBottom - newTop,
        pageNumber: current.pageNumber
      };
    } else {
      consolidated.push(current);
      current = next;
    }
  }
  if (current) {
    consolidated.push(current);
  }
  return consolidated;
};
var consolidateRects = (rects) => {
  if (rects.length <= 1) return rects;
  const result = [];
  const visited = /* @__PURE__ */ new Set();
  for (let i = 0; i < rects.length; i++) {
    if (visited.has(i)) continue;
    const currentRect = rects[i];
    if (!currentRect) continue;
    const currentGroup = [currentRect];
    visited.add(i);
    let foundNew = true;
    while (foundNew) {
      foundNew = false;
      for (let j = 0; j < rects.length; j++) {
        if (visited.has(j)) continue;
        const candidateRect = rects[j];
        if (!candidateRect) continue;
        const shouldMergeWithGroup = currentGroup.some(
          (groupRect) => doRectsOverlap(groupRect, candidateRect)
        );
        if (shouldMergeWithGroup) {
          currentGroup.push(candidateRect);
          visited.add(j);
          foundNew = true;
        }
      }
    }
    result.push(mergeRectGroup(currentGroup));
  }
  return result;
};
var doRectsOverlap = (rect1, rect2) => {
  const horizontalOverlap = rect1.left < rect2.left + rect2.width && rect2.left < rect1.left + rect1.width;
  const verticalOverlap = rect1.top < rect2.top + rect2.height && rect2.top < rect1.top + rect1.height;
  const closeEnough = shouldMergeRects(rect1, rect2);
  return horizontalOverlap && verticalOverlap || closeEnough;
};
var mergeRectGroup = (rects) => {
  if (rects.length === 1) {
    const rect = rects[0];
    if (!rect) throw new Error("Invalid rect in group");
    return rect;
  }
  const firstRect = rects[0];
  if (!firstRect) throw new Error("Invalid first rect in group");
  let minLeft = firstRect.left;
  let minTop = firstRect.top;
  let maxRight = firstRect.left + firstRect.width;
  let maxBottom = firstRect.top + firstRect.height;
  rects.forEach((rect) => {
    if (!rect) return;
    minLeft = Math.min(minLeft, rect.left);
    minTop = Math.min(minTop, rect.top);
    maxRight = Math.max(maxRight, rect.left + rect.width);
    maxBottom = Math.max(maxBottom, rect.top + rect.height);
  });
  return {
    left: minLeft,
    top: minTop,
    width: maxRight - minLeft,
    height: maxBottom - minTop,
    pageNumber: firstRect.pageNumber
  };
};
var useSelectionDimensions = () => {
  const store = PDFStore.useContext();
  const getAnnotationDimension = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const highlightRects = [];
    const underlineRects = [];
    const textLayerMapHighlight = /* @__PURE__ */ new Map();
    const textLayerMapUnderline = /* @__PURE__ */ new Map();
    const clientRects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 2 && rect.height > 2
    );
    clientRects.forEach((clientRect) => {
      let element = document.elementFromPoint(
        clientRect.left + 1,
        clientRect.top + clientRect.height / 2
      );
      if (!element) {
        element = document.elementFromPoint(
          clientRect.left + clientRect.width / 2,
          clientRect.top + clientRect.height / 2
        );
      }
      if (!element) {
        element = document.elementFromPoint(
          clientRect.right - 1,
          clientRect.top + clientRect.height / 2
        );
      }
      if (!element) {
        element = document.elementFromPoint(
          clientRect.left + clientRect.width / 2,
          clientRect.top + 1
        );
      }
      if (!element) {
        element = document.elementFromPoint(
          clientRect.left + clientRect.width / 2,
          clientRect.bottom - 1
        );
      }
      const textLayer = element?.closest(".textLayer");
      if (!textLayer) return;
      const isSuperOrSubScript = (el) => {
        if (!el) return false;
        if (el.tagName.toLowerCase() === "sup" || el.tagName.toLowerCase() === "sub") {
          return true;
        }
        const classes = el.className;
        if (typeof classes === "string") {
          const superSubClasses = ["superscript", "subscript", "sup", "sub"];
          if (superSubClasses.some((c) => classes.includes(c))) {
            return true;
          }
        }
        const elementRect = el.getBoundingClientRect();
        if (elementRect.height < 6 && elementRect.width < 15) {
          const textContent = el.textContent?.trim() || "";
          if (textContent.length <= 2 && /^[\d\w]{1,2}$/.test(textContent)) {
            const parentRect = el.parentElement?.getBoundingClientRect();
            if (parentRect && parentRect.height > elementRect.height * 2) {
              const elementCenter = elementRect.top + elementRect.height / 2;
              const parentCenter = parentRect.top + parentRect.height / 2;
              const verticalOffset = Math.abs(elementCenter - parentCenter);
              if (verticalOffset > parentRect.height * 0.4) {
                return true;
              }
            }
          }
        }
        return false;
      };
      const pageNumber = parseInt(
        textLayer.getAttribute("data-page-number") || "1",
        10
      );
      const textLayerRect = textLayer.getBoundingClientRect();
      const zoom = store.getState().zoom;
      const highlightRect = {
        width: clientRect.width / zoom,
        height: clientRect.height / zoom,
        top: (clientRect.top - textLayerRect.top) / zoom,
        left: (clientRect.left - textLayerRect.left) / zoom,
        pageNumber
      };
      if (!textLayerMapHighlight.has(pageNumber)) {
        textLayerMapHighlight.set(pageNumber, []);
      }
      textLayerMapHighlight.get(pageNumber)?.push(highlightRect);
      const shouldCreateUnderline = !isSuperOrSubScript(element);
      if (shouldCreateUnderline) {
        const baselineOffset = clientRect.height * 0.85;
        const underlineHeight = 2;
        const underlineRect = {
          width: clientRect.width / zoom,
          height: underlineHeight / zoom,
          top: (clientRect.top - textLayerRect.top + baselineOffset) / zoom,
          left: (clientRect.left - textLayerRect.left) / zoom,
          pageNumber
        };
        if (!textLayerMapUnderline.has(pageNumber)) {
          textLayerMapUnderline.set(pageNumber, []);
        }
        textLayerMapUnderline.get(pageNumber)?.push(underlineRect);
      }
    });
    textLayerMapHighlight.forEach((rects) => {
      if (rects.length > 0) {
        if (rects.length === 1) {
          highlightRects.push(...rects);
        } else {
          const consolidated = consolidateHighlightRects(rects);
          highlightRects.push(...consolidated);
        }
      }
    });
    textLayerMapUnderline.forEach((rects) => {
      if (rects.length > 0) {
        const lineGroups = groupRectsByLine(rects);
        lineGroups.forEach((group) => {
          if (group.length === 0) return;
          group.sort((a, b) => a.left - b.left);
          let i = 0;
          while (i < group.length) {
            const startRect = group[i];
            if (!startRect) {
              i++;
              continue;
            }
            let endIndex = i;
            while (endIndex + 1 < group.length) {
              const currentRect = group[endIndex];
              const nextRect = group[endIndex + 1];
              if (!currentRect || !nextRect) break;
              const gap = nextRect.left - (currentRect.left + currentRect.width);
              const maxGapAllowed = Math.max(
                MERGE_THRESHOLD,
                currentRect.height * 0.3
              );
              if (gap <= maxGapAllowed) {
                endIndex++;
              } else {
                break;
              }
            }
            const endRect = group[endIndex];
            if (!endRect) {
              i++;
              continue;
            }
            const lineRect = {
              width: endRect.left + endRect.width - startRect.left,
              height: 1.5,
              top: startRect.top,
              left: startRect.left,
              pageNumber: startRect.pageNumber
            };
            underlineRects.push(lineRect);
            i = endIndex + 1;
          }
        });
      }
    });
    if (underlineRects.length === 0 && highlightRects.length > 0) {
      highlightRects.forEach((highlightRect) => {
        const baselineOffset = highlightRect.height * 0.85;
        const underlineHeight = 1.5;
        const underlineRect = {
          width: highlightRect.width,
          height: underlineHeight,
          top: highlightRect.top + baselineOffset,
          left: highlightRect.left,
          pageNumber: highlightRect.pageNumber
        };
        underlineRects.push(underlineRect);
      });
    }
    return {
      highlights: highlightRects.sort((a, b) => a.pageNumber - b.pageNumber),
      underlines: consolidateUnderlines(underlineRects).sort(
        (a, b) => a.pageNumber - b.pageNumber
      ),
      text: range.toString().trim(),
      isCollapsed: false
    };
  };
  const groupRectsByLine = (rects) => {
    const VERTICAL_TOLERANCE = 3;
    const groups = [];
    rects.forEach((rect) => {
      const centerY = rect.top + rect.height / 2;
      let foundGroup = false;
      for (const group of groups) {
        if (group.length === 0) continue;
        const firstRect = group[0];
        if (!firstRect) continue;
        const groupCenterY = firstRect.top + firstRect.height / 2;
        if (Math.abs(centerY - groupCenterY) <= VERTICAL_TOLERANCE) {
          group.push(rect);
          foundGroup = true;
          break;
        }
      }
      if (!foundGroup) {
        groups.push([rect]);
      }
    });
    return groups;
  };
  const consolidateUnderlines = (underlines) => {
    if (underlines.length <= 1) return underlines;
    const consolidated = [];
    const sorted = [...underlines].sort((a, b) => {
      const pageCompare = a.pageNumber - b.pageNumber;
      if (pageCompare !== 0) return pageCompare;
      const topCompare = a.top - b.top;
      return Math.abs(topCompare) < 1 ? a.left - b.left : topCompare;
    });
    let current = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      const samePageAndLine = current.pageNumber === next.pageNumber && Math.abs(current.top - next.top) < 1;
      const horizontallyConnected = samePageAndLine && (Math.abs(current.left + current.width - next.left) <= MERGE_THRESHOLD || current.left < next.left + next.width && next.left < current.left + current.width);
      if (horizontallyConnected) {
        const newWidth = Math.max(current.left + current.width, next.left + next.width) - Math.min(current.left, next.left);
        current = {
          ...current,
          left: Math.min(current.left, next.left),
          width: newWidth
        };
      } else {
        consolidated.push(current);
        current = next;
      }
    }
    consolidated.push(current);
    return consolidated;
  };
  const getDimension = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const highlights = [];
    const textLayerMap = /* @__PURE__ */ new Map();
    const clientRects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 2 && rect.height > 2
    );
    clientRects.forEach((clientRect) => {
      const element = document.elementFromPoint(
        clientRect.left + 1,
        clientRect.top + clientRect.height / 2
      );
      const textLayer = element?.closest(".textLayer");
      if (!textLayer) return;
      const pageNumber = parseInt(
        textLayer.getAttribute("data-page-number") || "1",
        10
      );
      const textLayerRect = textLayer.getBoundingClientRect();
      const zoom = store.getState().zoom;
      const rect = {
        width: clientRect.width / zoom,
        height: clientRect.height / zoom,
        top: (clientRect.top - textLayerRect.top) / zoom,
        left: (clientRect.left - textLayerRect.left) / zoom,
        pageNumber
      };
      if (!textLayerMap.has(pageNumber)) {
        textLayerMap.set(pageNumber, []);
      }
      textLayerMap.get(pageNumber)?.push(rect);
    });
    textLayerMap.forEach((rects) => {
      if (rects.length > 0) {
        const consolidated = consolidateRects(rects);
        highlights.push(...consolidated);
      }
    });
    return {
      highlights: highlights.sort((a, b) => a.pageNumber - b.pageNumber),
      text: range.toString().trim(),
      isCollapsed: false
    };
  };
  const getSelection = () => getDimension();
  return { getDimension, getSelection, getAnnotationDimension };
};
var SelectionTooltip = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const lastSelectionRef = useRef(null);
  const viewportRef = usePdf((state) => state.viewportRef);
  const { refs, floatingStyles, context } = useFloating({
    placement: "bottom",
    open: isOpen,
    onOpenChange: setIsOpen,
    whileElementsMounted: autoUpdate,
    middleware: [offset(10), shift({ padding: 8 })]
  });
  const dismiss = useDismiss(context);
  const { getFloatingProps } = useInteractions([dismiss]);
  const updateTooltipPosition = useCallback(() => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) {
      setIsOpen(false);
      lastSelectionRef.current = null;
      return;
    }
    const range = selection.getRangeAt(0);
    if (!range) return;
    const rects = range.getClientRects();
    const lastRect = rects[rects.length - 1];
    lastSelectionRef.current = range;
    if (lastRect) {
      refs.setReference({
        getBoundingClientRect: () => ({
          width: lastRect.width,
          height: lastRect.height,
          x: lastRect.left,
          y: lastRect.bottom,
          // Position below the last line of selection
          top: lastRect.bottom,
          right: lastRect.right,
          bottom: lastRect.bottom + lastRect.height,
          left: lastRect.left
        }),
        getClientRects: () => [lastRect]
      });
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  }, [refs]);
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = document.getSelection();
      if (selection && viewportRef.current?.contains(selection.anchorNode)) {
        const anchorNode = selection.anchorNode;
        const focusNode = selection.focusNode;
        const isInUnselectableArea = (node) => {
          if (!node) return false;
          let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
          while (element) {
            if (element.getAttribute("data-annotation-tooltip")) {
              return true;
            }
            if (element.hasAttribute("data-floating-ui-portal")) {
              return true;
            }
            element = element.parentElement;
          }
          return false;
        };
        if (!isInUnselectableArea(anchorNode) && !isInUnselectableArea(focusNode)) {
          requestAnimationFrame(updateTooltipPosition);
        } else {
          setIsOpen(false);
        }
      } else {
        setIsOpen(false);
      }
    };
    const handleScroll = () => {
      if (!isOpen || !lastSelectionRef.current) return;
      requestAnimationFrame(updateTooltipPosition);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    if (viewportRef.current) {
      viewportRef.current.addEventListener("scroll", handleScroll, {
        passive: true
      });
    }
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (viewportRef.current) {
        viewportRef.current.removeEventListener("scroll", handleScroll);
      }
    };
  }, [isOpen, viewportRef, updateTooltipPosition]);
  useEffect(() => {
    const handleFloatingClick = (e) => {
      if (refs.floating.current?.contains(e.target)) {
        e.stopPropagation();
      }
    };
    document.addEventListener("click", handleFloatingClick);
    return () => document.removeEventListener("click", handleFloatingClick);
  }, [refs.floating]);
  return /* @__PURE__ */ jsx(Fragment, { children: isOpen && /* @__PURE__ */ jsx(
    "div",
    {
      ref: refs.setFloating,
      style: { ...floatingStyles },
      ...getFloatingProps(),
      children
    }
  ) });
};
var defaultColors = [
  {
    color: "#e3b127",
    localization: {
      id: "yellow",
      defaultMessage: "Yellow"
    }
  },
  {
    color: "#419931",
    localization: {
      id: "green",
      defaultMessage: "Green"
    }
  },
  {
    color: "#4286c9",
    localization: {
      id: "blue",
      defaultMessage: "Blue"
    }
  },
  {
    color: "#f246b6",
    localization: {
      id: "pink",
      defaultMessage: "Pink"
    }
  },
  {
    color: "#a53dd1",
    localization: {
      id: "purple",
      defaultMessage: "Purple"
    }
  },
  {
    color: "#f09037",
    localization: {
      id: "orange",
      defaultMessage: "Orange"
    }
  },
  {
    color: "#37f0d4",
    localization: {
      id: "teal",
      defaultMessage: "Teal"
    }
  },
  {
    color: "#3d0ff5",
    localization: {
      id: "purple",
      defaultMessage: "Purple"
    }
  },
  {
    color: "#f50f26",
    localization: {
      id: "red",
      defaultMessage: "Red"
    }
  }
];
var ColorSelectionTool = ({
  highlighterColors = defaultColors,
  onColorSelection
}) => {
  return /* @__PURE__ */ jsx(SelectionTooltip, { children: /* @__PURE__ */ jsx(
    "div",
    {
      style: {
        display: "flex",
        gap: "0.5rem",
        padding: "0.5rem",
        backgroundColor: "#363636",
        borderRadius: "0.5rem"
      },
      children: highlighterColors.map((colorItem, index) => /* @__PURE__ */ jsx(
        "button",
        {
          onClick: () => onColorSelection(colorItem),
          title: colorItem.localization.defaultMessage,
          "aria-label": colorItem.localization.defaultMessage,
          style: {
            width: "1.25rem",
            height: "1.25rem",
            borderRadius: "0.25rem",
            cursor: "pointer",
            backgroundColor: colorItem.color
          }
        },
        index
      ))
    }
  ) });
};

// src/utils/selectionUtils.ts
var getEndOfHighlight = (selection) => {
  const lastRectangle = selection.rectangles[selection.rectangles.length - 1];
  return lastRectangle.left + lastRectangle.width + 10;
};
var getMidHeightOfHighlightLine = (selection) => {
  const lastRectangle = selection.rectangles[selection.rectangles.length - 1];
  return lastRectangle.top + lastRectangle.height / 2;
};
var ColoredHighlightComponent = ({
  selection
}) => {
  const deleteColoredHighlight = usePdf(
    (state) => state.deleteColoredHighlight
  );
  const [showButton, setShowButton] = useState(false);
  return /* @__PURE__ */ jsxs("div", { className: "colored-highlight", children: [
    selection.rectangles.map((rect, index) => /* @__PURE__ */ jsx(
      "span",
      {
        onClick: () => setShowButton(!showButton),
        style: {
          position: "absolute",
          top: rect.top,
          left: rect.left,
          height: rect.height,
          width: rect.width,
          cursor: "pointer",
          zIndex: 30,
          backgroundColor: selection.color,
          // mixBlendMode: "lighten", // changes the color of the text
          mixBlendMode: "darken",
          // best results
          // mixBlendMode: "multiply", // works but coloring has some inconsistencies
          borderRadius: "0.2rem"
        }
      },
      `${selection.uuid}-${index}`
    )),
    showButton && /* @__PURE__ */ jsx(
      "button",
      {
        style: {
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
          transform: "translateY(-50%)"
        },
        onClick: () => deleteColoredHighlight(selection.uuid),
        children: /* @__PURE__ */ jsx(
          "svg",
          {
            fill: "#000000",
            version: "1.1",
            id: "Capa_1",
            xmlns: "http://www.w3.org/2000/svg",
            width: "15px",
            height: "15px",
            viewBox: "0 0 485 485",
            children: /* @__PURE__ */ jsx("g", { children: /* @__PURE__ */ jsxs("g", { children: [
              /* @__PURE__ */ jsx("rect", { x: "67.224", width: "350.535", height: "71.81" }),
              /* @__PURE__ */ jsx(
                "path",
                {
                  d: "M417.776,92.829H67.237V485h350.537V92.829H417.776z M165.402,431.447h-28.362V146.383h28.362V431.447z M256.689,431.447\n			h-28.363V146.383h28.363V431.447z M347.97,431.447h-28.361V146.383h28.361V431.447z"
                }
              )
            ] }) })
          }
        )
      },
      `${selection.uuid}-delete-button`
    )
  ] });
};
var ColoredHighlightLayer = ({
  onHighlight
}) => {
  const pageNumber = usePDFPageNumber();
  const { getDimension } = useSelectionDimensions();
  const highlights = usePdf(
    (state) => state.coloredHighlights
  );
  const addColoredHighlight = usePdf((state) => state.addColoredHighlight);
  const pageHighlights = useMemo(
    () => highlights.filter((s) => s.pageNumber === pageNumber),
    [highlights, pageNumber]
  );
  const handleHighlighting = useCallback(
    (color) => {
      const dimension = getDimension();
      if (!dimension) return;
      const { highlights: highlights2, text } = dimension;
      if (highlights2[0]) {
        const highlight = {
          uuid: v4(),
          pageNumber: highlights2[0].pageNumber,
          // usePDFPageNumber() doesn't return the correct page number, so i'm getting the number directly from the first highlight
          color,
          rectangles: highlights2,
          text
        };
        addColoredHighlight(highlight);
        if (onHighlight) onHighlight(highlight);
      }
    },
    [onHighlight, getDimension, addColoredHighlight]
  );
  return /* @__PURE__ */ jsxs("div", { className: "colored-highlights-layer", children: [
    pageHighlights.map((selection) => /* @__PURE__ */ jsx(ColoredHighlightComponent, { selection }, selection.uuid)),
    /* @__PURE__ */ jsx(
      ColorSelectionTool,
      {
        onColorSelection: (colorItem) => handleHighlighting(colorItem.color)
      }
    )
  ] });
};
var CustomLayer = memo(
  ({ children }) => {
    const pageNumber = usePDFPageNumber();
    return children(pageNumber);
  }
);
CustomLayer.displayName = "CustomLayer";
var convertToPercentString = (rect) => {
  return {
    top: `${rect.top}%`,
    left: `${rect.left}%`,
    height: `${rect.height}%`,
    width: `${rect.width}%`
  };
};
var HighlightLayer = forwardRef(({ asChild, className, style, ...props }, ref) => {
  const pageNumber = usePDFPageNumber();
  const highlights = usePdf((state) => state.highlights);
  const Comp = asChild ? Slot : "div";
  const rects = useMemo(
    () => highlights.filter((area) => area.pageNumber === pageNumber),
    [highlights, pageNumber]
  );
  if (!rects?.length) return null;
  return /* @__PURE__ */ jsx(Fragment, { children: rects.map((rect, index) => {
    const { pageNumber: pageNumber2, type, style: customStyle, ...coordinates } = rect;
    let dimensions = coordinates;
    if (type === "percent") {
      dimensions = convertToPercentString(rect);
    }
    const customStyles = customStyle ? customStyle(rect) : {};
    return /* @__PURE__ */ jsx(
      Comp,
      {
        ref,
        className,
        style: {
          position: "absolute",
          ...dimensions,
          pointerEvents: "none",
          zIndex: 30,
          ...style,
          ...customStyles
        },
        ...props,
        children: props.children
      },
      `highlight-${pageNumber2}-${index}`
    );
  }) });
});
HighlightLayer.displayName = "HighlightLayer";
var createTextSelectionManager = () => {
  const textLayers = /* @__PURE__ */ new Map();
  let selectionChangeAbortController = null;
  let isPointerDown = false;
  let prevRange = null;
  let isFirefox;
  const removeGlobalSelectionListener = (textLayerDiv) => {
    textLayers.delete(textLayerDiv);
    if (textLayers.size === 0) {
      selectionChangeAbortController?.abort();
      selectionChangeAbortController = null;
    }
  };
  const enableGlobalSelectionListener = () => {
    if (selectionChangeAbortController) {
      return;
    }
    selectionChangeAbortController = new AbortController();
    const { signal } = selectionChangeAbortController;
    const reset = (endDiv, textLayer) => {
      if (endDiv.parentNode !== textLayer) {
        textLayer.appendChild(endDiv);
      }
      endDiv.style.width = "";
      endDiv.style.height = "";
      textLayer.classList.remove("selecting");
    };
    document.addEventListener(
      "pointerdown",
      () => {
        isPointerDown = true;
      },
      { signal }
    );
    document.addEventListener(
      "pointerup",
      () => {
        isPointerDown = false;
        textLayers.forEach(reset);
      },
      { signal }
    );
    window.addEventListener(
      "blur",
      () => {
        isPointerDown = false;
        textLayers.forEach(reset);
      },
      { signal }
    );
    document.addEventListener(
      "keyup",
      () => {
        if (!isPointerDown) {
          textLayers.forEach(reset);
        }
      },
      { signal }
    );
    document.addEventListener(
      "selectionchange",
      () => {
        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0) {
          textLayers.forEach(reset);
          return;
        }
        const activeTextLayers = /* @__PURE__ */ new Set();
        for (let i = 0; i < selection.rangeCount; i++) {
          const range = selection.getRangeAt(i);
          for (const textLayerDiv of textLayers.keys()) {
            if (!activeTextLayers.has(textLayerDiv) && range.intersectsNode(textLayerDiv)) {
              activeTextLayers.add(textLayerDiv);
            }
          }
        }
        for (const [textLayerDiv, endDiv] of textLayers) {
          if (activeTextLayers.has(textLayerDiv)) {
            textLayerDiv.classList.add("selecting");
          } else {
            reset(endDiv, textLayerDiv);
          }
        }
        if (isFirefox === void 0) {
          const firstTextLayer = textLayers.keys().next().value;
          if (firstTextLayer) {
            isFirefox = getComputedStyle(firstTextLayer).getPropertyValue(
              "-moz-user-select"
            ) === "none";
          }
        }
        if (isFirefox) {
          return;
        }
        try {
          const range = selection.getRangeAt(0);
          const modifyStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
          let anchor = modifyStart ? range.startContainer : range.endContainer;
          if (anchor.nodeType === Node.TEXT_NODE) {
            anchor = anchor.parentNode;
          }
          const parentTextLayer = anchor.parentElement?.closest(
            ".textLayer"
          );
          const endDiv = textLayers.get(parentTextLayer);
          if (endDiv && parentTextLayer) {
            endDiv.style.width = parentTextLayer.style.width;
            endDiv.style.height = parentTextLayer.style.height;
            const insertTarget = modifyStart ? anchor : anchor.nextSibling;
            if (anchor.parentElement && insertTarget) {
              anchor.parentElement.insertBefore(endDiv, insertTarget);
            }
          }
          prevRange = range.cloneRange();
        } catch {
        }
      },
      { signal }
    );
  };
  const bindMouseEvents2 = (textLayerDiv, endOfContent) => {
    if (textLayerDiv._textSelectionBound) {
      return;
    }
    textLayerDiv._textSelectionBound = true;
    textLayers.set(textLayerDiv, endOfContent);
    enableGlobalSelectionListener();
    const handleMouseDown = () => {
      textLayerDiv.classList.add("selecting");
    };
    textLayerDiv.addEventListener("mousedown", handleMouseDown);
    textLayerDiv._cleanupTextSelection = () => {
      textLayerDiv.removeEventListener("mousedown", handleMouseDown);
      removeGlobalSelectionListener(textLayerDiv);
      delete textLayerDiv._textSelectionBound;
    };
  };
  return bindMouseEvents2;
};
var bindMouseEvents = createTextSelectionManager();
var useTextLayer = () => {
  const textContainerRef = useRef(null);
  const textLayerRef = useRef(null);
  const isRenderingRef = useRef(false);
  const pageNumber = usePDFPageNumber();
  const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
  useEffect(() => {
    const textContainer = textContainerRef.current;
    if (!textContainer || isRenderingRef.current) {
      return;
    }
    let isCancelled = false;
    isRenderingRef.current = true;
    textContainer.innerHTML = "";
    if (textLayerRef.current) {
      textLayerRef.current.cancel();
      textLayerRef.current = null;
    }
    void import('pdfjs-dist/legacy/build/pdf.mjs').then(({ TextLayer: TextLayer2 }) => {
      if (isCancelled || textContainerRef.current !== textContainer) return;
      const textLayer = new TextLayer2({
        textContentSource: pdfPageProxy.streamTextContent(),
        container: textContainer,
        viewport: pdfPageProxy.getViewport({ scale: 1 })
      });
      textLayerRef.current = textLayer;
      return textLayer.render();
    }).then(() => {
      if (isCancelled || textContainerRef.current !== textContainer) {
        return;
      }
      const endOfContent = document.createElement("div");
      endOfContent.className = "endOfContent";
      textContainer.appendChild(endOfContent);
      bindMouseEvents(textContainer, endOfContent);
    }).catch((error) => {
      if (error instanceof Error && error.name !== "AbortException") {
        console.error("TextLayer rendering error:", error);
      }
    }).finally(() => {
      isRenderingRef.current = false;
    });
    return () => {
      isCancelled = true;
      isRenderingRef.current = false;
      if (textLayerRef.current) {
        textLayerRef.current.cancel();
        textLayerRef.current = null;
      }
      if (textContainer?._cleanupTextSelection) {
        textContainer._cleanupTextSelection();
        delete textContainer._cleanupTextSelection;
      }
    };
  }, [pdfPageProxy.streamTextContent, pdfPageProxy.getViewport]);
  return {
    textContainerRef,
    pageNumber: pdfPageProxy.pageNumber
  };
};
var TEXT_LAYER_STYLE = {
  position: "absolute",
  top: 0,
  left: 0,
  contain: "strict"
};
var TextLayer = memo(
  ({ className, style, ...props }) => {
    const { textContainerRef, pageNumber } = useTextLayer();
    return /* @__PURE__ */ jsx(
      "div",
      {
        className: clsx_default("textLayer", className),
        style: {
          ...TEXT_LAYER_STYLE,
          ...style
        },
        ...props,
        ...{
          "data-page-number": pageNumber
        },
        ref: textContainerRef
      }
    );
  }
);
TextLayer.displayName = "TextLayer";

// src/lib/cancellable.ts
var cancellable = (promise) => {
  let isCancelled = false;
  const wrappedPromise = new Promise((resolve, reject) => {
    promise.then(
      (value) => {
        if (!isCancelled) {
          resolve(value);
        }
      },
      (error) => {
        if (!isCancelled) {
          reject(error);
        }
      }
    );
  });
  return {
    promise: wrappedPromise,
    cancel() {
      isCancelled = true;
    }
  };
};

// src/hooks/usePdfOutline.tsx
var usePDFOutline = () => {
  const pdfDocumentProxy = usePdf((state) => state.pdfDocumentProxy);
  const [outline, setOutline] = useState();
  useEffect(() => {
    const { promise: outline2, cancel } = cancellable(
      pdfDocumentProxy.getOutline()
    );
    outline2.then(
      (result) => {
        setOutline(result);
      },
      () => {
      }
    );
    return () => {
      cancel();
    };
  }, [pdfDocumentProxy]);
  return outline;
};
var HTMLTags = [
  "a",
  "button",
  "div",
  "aside",
  "section",
  "main",
  "ul",
  "li",
  "input",
  "canvas"
];
var makePrimitive = (htmlTag) => {
  const primitive = forwardRef(
    (props, ref) => {
      const Renderer = htmlTag;
      return /* @__PURE__ */ jsx(Renderer, { ...props, ref });
    }
  );
  primitive.displayName = `PDFReader.${htmlTag}`;
  return primitive;
};
var Primitive = HTMLTags.reduce((acc, tag) => {
  acc[tag] = makePrimitive(tag);
  return acc;
}, {});
var OutlineChildItems = ({
  ...props
}) => {
  return /* @__PURE__ */ jsx(Primitive.ul, { ...props });
};
var OutlineItem = ({
  level = 0,
  item,
  children,
  outlineItem,
  ...props
}) => {
  if (!item || !outlineItem || !children) {
    throw new Error("Outline item is required");
  }
  const pdfDocumentProxy = usePdf((state) => state.pdfDocumentProxy);
  const { jumpToPage } = usePdfJump();
  const getDestinationPage = useCallback(
    async (dest) => {
      let explicitDest;
      if (typeof dest === "string") {
        explicitDest = await pdfDocumentProxy.getDestination(dest);
      } else if (Array.isArray(dest)) {
        explicitDest = dest;
      } else {
        explicitDest = await dest;
      }
      if (!explicitDest) {
        return;
      }
      const explicitRef = explicitDest[0];
      const page = await pdfDocumentProxy.getPageIndex(explicitRef);
      return page;
    },
    [pdfDocumentProxy]
  );
  const navigate = useCallback(() => {
    if (!item.dest) {
      return;
    }
    getDestinationPage(item.dest).then((page) => {
      if (!page) {
        return;
      }
      jumpToPage(page, { behavior: "smooth" });
    });
  }, [item.dest, jumpToPage, getDestinationPage]);
  return /* @__PURE__ */ jsxs(Primitive.li, { ...props, children: [
    /* @__PURE__ */ jsx(
      "a",
      {
        role: "button",
        tabIndex: 0,
        onClick: navigate,
        onKeyUp: (e) => {
          if (e.key === "Enter") {
            navigate();
          }
        },
        "data-level": level,
        children: item.title
      }
    ),
    item.items && item.items.length > 0 && cloneElement(children, {
      // @ts-expect-error we are missing the corect props types
      children: item.items.map(
        (item2, index) => cloneElement(outlineItem, {
          // @ts-expect-error we are missing the corect props types
          level: level + 1,
          item: item2,
          outlineItem,
          // biome-ignore lint/suspicious/noArrayIndexKey: <stuff>
          key: index
        })
      )
    })
  ] });
};
var Outline = ({
  children,
  ...props
}) => {
  const outline = usePDFOutline();
  return /* @__PURE__ */ jsx(Primitive.ul, { ...props, children: outline?.map((item, idx) => {
    return cloneElement(children, {
      key: idx,
      item,
      outlineItem: children
    });
  }) });
};
var Page = memo(
  ({
    children,
    pageNumber = 1,
    style,
    ...props
  }) => {
    const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
    const viewport = usePdf((state) => state.viewports[pageNumber - 1]);
    const width = viewport?.width ?? (pdfPageProxy.view[2] ?? 0) - (pdfPageProxy.view[0] ?? 0);
    const height = viewport?.height ?? (pdfPageProxy.view[3] ?? 0) - (pdfPageProxy.view[1] ?? 0);
    return /* @__PURE__ */ jsx(PDFPageNumberContext.Provider, { value: pdfPageProxy.pageNumber, children: /* @__PURE__ */ jsx(
      Primitive.div,
      {
        style: {
          display: "block",
          transform: "translateZ(0)",
          contentVisibility: "auto",
          containIntrinsicSize: `${width}px ${height}px`,
          contain: "content"
        },
        children: /* @__PURE__ */ jsx(
          "div",
          {
            style: {
              "--scale-factor": 1,
              "--total-scale-factor": 1,
              backgroundColor: "white",
              position: "relative",
              width,
              height,
              ...style
            },
            ...props,
            children
          }
        )
      }
    ) });
  }
);
Page.displayName = "Page";
var NextPage = () => {
};
var PreviousPage = () => {
};
var CurrentPage = ({ ...props }) => {
  const currentPage = usePdf((state) => state.currentPage);
  const pages = usePdf((state) => state.pdfDocumentProxy.numPages);
  const [pageNumber, setPageNumber] = useState(currentPage);
  const isSelected = useRef(false);
  const { jumpToPage } = usePdfJump();
  useEffect(() => {
    if (isSelected.current) {
      return;
    }
    setPageNumber(currentPage);
  }, [currentPage]);
  return /* @__PURE__ */ jsx(
    "input",
    {
      type: "number",
      ...props,
      style: {
        ...props.style,
        appearance: "textfield",
        MozAppearance: "textfield",
        WebkitAppearance: "none"
      },
      value: pageNumber,
      onChange: (e) => {
        setPageNumber(e.target.value);
      },
      onClick: () => {
        isSelected.current = true;
      },
      onBlur: (e) => {
        if (currentPage !== Number(e.target.value)) {
          jumpToPage(Number(e.target.value), {
            behavior: "auto"
          });
        }
        isSelected.current = false;
      },
      onKeyDown: (e) => {
        e.key === "Enter" && e.currentTarget.blur();
      },
      min: 1,
      max: pages
    }
  );
};
var TotalPages = ({ ...props }) => {
  const pages = usePdf((state) => state.pdfDocumentProxy.numPages);
  return /* @__PURE__ */ jsx("div", { ...props, children: pages });
};
var useFitWidth = ({ viewportRef }) => {
  const viewports = usePdf((state) => state.viewports);
  const zoomOptions = usePdf((state) => state.zoomOptions);
  const updateZoom = usePdf((state) => state.updateZoom);
  const store = PDFStore.useContext();
  useLayoutEffect(() => {
    if (viewportRef.current === null) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const isFitWidth = store.getState().isZoomFitWidth;
        if (entry.target === viewportRef.current && isFitWidth) {
          const containerWidth = entry.contentRect.width;
          const newZoom = getFitWidthZoom(
            containerWidth,
            viewports,
            zoomOptions
          );
          updateZoom(newZoom, true);
        }
      }
    });
    resizeObserver.observe(viewportRef.current);
    return () => {
      resizeObserver.disconnect();
    };
  }, [store, updateZoom, viewportRef, viewports, zoomOptions]);
  return null;
};
var supportsScrollend = typeof window === "undefined" ? true : "onscrollend" in window;
var addEventListenerOptions = {
  passive: true
};
var useObserveElement = () => {
  const store = PDFStore.useContext();
  const offsetListenersRef = useRef(/* @__PURE__ */ new Set());
  const controller = {
    addOffsetListener: (fn) => {
      offsetListenersRef.current.add(fn);
      return () => {
        offsetListenersRef.current.delete(fn);
      };
    }
  };
  const observeElementOffset = (instance, cb) => {
    const element = instance.scrollElement;
    if (!element) {
      return;
    }
    const targetWindow = instance.targetWindow;
    if (!targetWindow) {
      return;
    }
    let offset3 = 0;
    let rafId = null;
    let pendingIsScrolling = true;
    let latestRawOffset = 0;
    const fallback = instance.options.useScrollendEvent && supportsScrollend ? () => void 0 : debounce(
      targetWindow,
      () => {
        cb(offset3, false);
      },
      instance.options.isScrollingResetDelay
    );
    const flush = () => {
      rafId = null;
      const zoom = store.getState().zoom;
      const next = latestRawOffset / zoom;
      offset3 = next;
      fallback();
      if (pendingIsScrolling) {
        notifyScrollActivity();
      }
      cb(next, pendingIsScrolling);
      const listeners = offsetListenersRef.current;
      if (listeners.size) {
        listeners.forEach((fn) => fn(next));
      }
    };
    const schedule = (isScrolling) => {
      const { horizontal, isRtl } = instance.options;
      latestRawOffset = horizontal ? element.scrollLeft * (isRtl && -1 || 1) : element.scrollTop;
      pendingIsScrolling = isScrolling;
      if (rafId !== null) return;
      rafId = targetWindow.requestAnimationFrame(flush);
    };
    const handler = () => schedule(true);
    const endHandler = () => {
      if (rafId !== null) {
        targetWindow.cancelAnimationFrame(rafId);
        rafId = null;
      }
      const { horizontal, isRtl } = instance.options;
      latestRawOffset = horizontal ? element.scrollLeft * (isRtl && -1 || 1) : element.scrollTop;
      pendingIsScrolling = false;
      flush();
    };
    endHandler();
    element.addEventListener("scroll", handler, addEventListenerOptions);
    element.addEventListener("scrollend", endHandler, addEventListenerOptions);
    return () => {
      if (rafId !== null) {
        targetWindow.cancelAnimationFrame(rafId);
        rafId = null;
      }
      element.removeEventListener("scroll", handler);
      element.removeEventListener("scrollend", endHandler);
    };
  };
  return {
    observeElementOffset,
    controller
  };
};
var useScrollFn = () => {
  const store = PDFStore.useContext();
  const scrollToFn = useCallback(
    (_offset, canSmooth, instance) => {
      const zoom = store.getState().zoom;
      const offset3 = _offset * zoom;
      elementScroll(offset3, canSmooth, instance);
    },
    [store]
  );
  return { scrollToFn };
};
var useVisiblePage = ({ items }) => {
  const zoomLevel = usePdf((state) => state.zoom);
  const isPinching = usePdf((state) => state.isPinching);
  const setCurrentPage = usePdf((state) => state.setCurrentPage);
  const scrollElement = usePdf((state) => state.viewportRef?.current);
  const lastPageRef = useRef(0);
  const calculateVisiblePageIndex = useCallback(
    (virtualItems) => {
      if (!scrollElement || virtualItems.length === 0) return 0;
      const scrollTop = scrollElement.scrollTop / zoomLevel;
      const viewportHeight = scrollElement.clientHeight / zoomLevel;
      const viewportCenter = scrollTop + viewportHeight / 2;
      let closestIndex = 0;
      let smallestDistance = Infinity;
      for (const item of virtualItems) {
        const itemCenter = item.start + item.size / 2;
        const distance = Math.abs(itemCenter - viewportCenter);
        if (distance < smallestDistance * 0.8) {
          smallestDistance = distance;
          closestIndex = item.index;
        }
      }
      return closestIndex;
    },
    [scrollElement, zoomLevel]
  );
  useEffect(() => {
    if (!isPinching && items.length > 0) {
      const mostVisibleIndex = calculateVisiblePageIndex(items);
      const page = mostVisibleIndex + 1;
      if (page !== lastPageRef.current) {
        lastPageRef.current = page;
        startTransition(() => {
          setCurrentPage?.(page);
        });
      }
    }
  }, [items, isPinching, calculateVisiblePageIndex, setCurrentPage]);
  return null;
};

// ../../node_modules/.pnpm/@use-gesture+core@10.3.1/node_modules/@use-gesture/core/dist/maths-0ab39ae9.esm.js
function clamp2(v, min, max) {
  return Math.max(min, Math.min(v, max));
}
var V = {
  toVector(v, fallback) {
    if (v === void 0) v = fallback;
    return Array.isArray(v) ? v : [v, v];
  },
  add(v1, v2) {
    return [v1[0] + v2[0], v1[1] + v2[1]];
  },
  sub(v1, v2) {
    return [v1[0] - v2[0], v1[1] - v2[1]];
  },
  addTo(v1, v2) {
    v1[0] += v2[0];
    v1[1] += v2[1];
  },
  subTo(v1, v2) {
    v1[0] -= v2[0];
    v1[1] -= v2[1];
  }
};
function rubberband(distance, dimension, constant) {
  if (dimension === 0 || Math.abs(dimension) === Infinity) return Math.pow(distance, constant * 5);
  return distance * dimension * constant / (dimension + constant * distance);
}
function rubberbandIfOutOfBounds(position, min, max, constant = 0.15) {
  if (constant === 0) return clamp2(position, min, max);
  if (position < min) return -rubberband(min - position, max - min, constant) + min;
  if (position > max) return +rubberband(position - max, max - min, constant) + max;
  return position;
}
function computeRubberband(bounds, [Vx, Vy], [Rx, Ry]) {
  const [[X0, X1], [Y0, Y1]] = bounds;
  return [rubberbandIfOutOfBounds(Vx, X0, X1, Rx), rubberbandIfOutOfBounds(Vy, Y0, Y1, Ry)];
}

// ../../node_modules/.pnpm/@use-gesture+core@10.3.1/node_modules/@use-gesture/core/dist/actions-fe213e88.esm.js
function _toPrimitive(input, hint) {
  if (typeof input !== "object" || input === null) return input;
  var prim = input[Symbol.toPrimitive];
  if (prim !== void 0) {
    var res = prim.call(input, hint || "default");
    if (typeof res !== "object") return res;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (hint === "string" ? String : Number)(input);
}
function _toPropertyKey(arg) {
  var key = _toPrimitive(arg, "string");
  return typeof key === "symbol" ? key : String(key);
}
function _defineProperty(obj, key, value) {
  key = _toPropertyKey(key);
  if (key in obj) {
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  } else {
    obj[key] = value;
  }
  return obj;
}
function ownKeys(e, r2) {
  var t = Object.keys(e);
  if (Object.getOwnPropertySymbols) {
    var o = Object.getOwnPropertySymbols(e);
    r2 && (o = o.filter(function(r3) {
      return Object.getOwnPropertyDescriptor(e, r3).enumerable;
    })), t.push.apply(t, o);
  }
  return t;
}
function _objectSpread2(e) {
  for (var r2 = 1; r2 < arguments.length; r2++) {
    var t = null != arguments[r2] ? arguments[r2] : {};
    r2 % 2 ? ownKeys(Object(t), true).forEach(function(r3) {
      _defineProperty(e, r3, t[r3]);
    }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function(r3) {
      Object.defineProperty(e, r3, Object.getOwnPropertyDescriptor(t, r3));
    });
  }
  return e;
}
var EVENT_TYPE_MAP = {
  pointer: {
    start: "down",
    change: "move",
    end: "up"
  },
  mouse: {
    start: "down",
    change: "move",
    end: "up"
  },
  touch: {
    start: "start",
    change: "move",
    end: "end"
  },
  gesture: {
    start: "start",
    change: "change",
    end: "end"
  }
};
function capitalize(string) {
  if (!string) return "";
  return string[0].toUpperCase() + string.slice(1);
}
var actionsWithoutCaptureSupported = ["enter", "leave"];
function hasCapture(capture = false, actionKey) {
  return capture && !actionsWithoutCaptureSupported.includes(actionKey);
}
function toHandlerProp(device, action = "", capture = false) {
  const deviceProps = EVENT_TYPE_MAP[device];
  const actionKey = deviceProps ? deviceProps[action] || action : action;
  return "on" + capitalize(device) + capitalize(actionKey) + (hasCapture(capture, actionKey) ? "Capture" : "");
}
var pointerCaptureEvents = ["gotpointercapture", "lostpointercapture"];
function parseProp(prop) {
  let eventKey = prop.substring(2).toLowerCase();
  const passive = !!~eventKey.indexOf("passive");
  if (passive) eventKey = eventKey.replace("passive", "");
  const captureKey = pointerCaptureEvents.includes(eventKey) ? "capturecapture" : "capture";
  const capture = !!~eventKey.indexOf(captureKey);
  if (capture) eventKey = eventKey.replace("capture", "");
  return {
    device: eventKey,
    capture,
    passive
  };
}
function toDomEventType(device, action = "") {
  const deviceProps = EVENT_TYPE_MAP[device];
  const actionKey = deviceProps ? deviceProps[action] || action : action;
  return device + actionKey;
}
function isTouch(event) {
  return "touches" in event;
}
function getPointerType(event) {
  if (isTouch(event)) return "touch";
  if ("pointerType" in event) return event.pointerType;
  return "mouse";
}
function getCurrentTargetTouchList(event) {
  return Array.from(event.touches).filter((e) => {
    var _event$currentTarget, _event$currentTarget$;
    return e.target === event.currentTarget || ((_event$currentTarget = event.currentTarget) === null || _event$currentTarget === void 0 || (_event$currentTarget$ = _event$currentTarget.contains) === null || _event$currentTarget$ === void 0 ? void 0 : _event$currentTarget$.call(_event$currentTarget, e.target));
  });
}
function getTouchList(event) {
  return event.type === "touchend" || event.type === "touchcancel" ? event.changedTouches : event.targetTouches;
}
function getValueEvent(event) {
  return isTouch(event) ? getTouchList(event)[0] : event;
}
function distanceAngle(P1, P2) {
  try {
    const dx = P2.clientX - P1.clientX;
    const dy = P2.clientY - P1.clientY;
    const cx = (P2.clientX + P1.clientX) / 2;
    const cy = (P2.clientY + P1.clientY) / 2;
    const distance = Math.hypot(dx, dy);
    const angle = -(Math.atan2(dx, dy) * 180) / Math.PI;
    const origin = [cx, cy];
    return {
      angle,
      distance,
      origin
    };
  } catch (_unused) {
  }
  return null;
}
function touchIds(event) {
  return getCurrentTargetTouchList(event).map((touch) => touch.identifier);
}
function touchDistanceAngle(event, ids) {
  const [P1, P2] = Array.from(event.touches).filter((touch) => ids.includes(touch.identifier));
  return distanceAngle(P1, P2);
}
function pointerId(event) {
  const valueEvent = getValueEvent(event);
  return isTouch(event) ? valueEvent.identifier : valueEvent.pointerId;
}
function pointerValues(event) {
  const valueEvent = getValueEvent(event);
  return [valueEvent.clientX, valueEvent.clientY];
}
var LINE_HEIGHT = 40;
var PAGE_HEIGHT = 800;
function wheelValues(event) {
  let {
    deltaX,
    deltaY,
    deltaMode
  } = event;
  if (deltaMode === 1) {
    deltaX *= LINE_HEIGHT;
    deltaY *= LINE_HEIGHT;
  } else if (deltaMode === 2) {
    deltaX *= PAGE_HEIGHT;
    deltaY *= PAGE_HEIGHT;
  }
  return [deltaX, deltaY];
}
function scrollValues(event) {
  var _ref, _ref2;
  const {
    scrollX,
    scrollY,
    scrollLeft,
    scrollTop
  } = event.currentTarget;
  return [(_ref = scrollX !== null && scrollX !== void 0 ? scrollX : scrollLeft) !== null && _ref !== void 0 ? _ref : 0, (_ref2 = scrollY !== null && scrollY !== void 0 ? scrollY : scrollTop) !== null && _ref2 !== void 0 ? _ref2 : 0];
}
function getEventDetails(event) {
  const payload = {};
  if ("buttons" in event) payload.buttons = event.buttons;
  if ("shiftKey" in event) {
    const {
      shiftKey,
      altKey,
      metaKey,
      ctrlKey
    } = event;
    Object.assign(payload, {
      shiftKey,
      altKey,
      metaKey,
      ctrlKey
    });
  }
  return payload;
}
function call(v, ...args) {
  if (typeof v === "function") {
    return v(...args);
  } else {
    return v;
  }
}
function noop() {
}
function chain(...fns) {
  if (fns.length === 0) return noop;
  if (fns.length === 1) return fns[0];
  return function() {
    let result;
    for (const fn of fns) {
      result = fn.apply(this, arguments) || result;
    }
    return result;
  };
}
function assignDefault(value, fallback) {
  return Object.assign({}, fallback, value || {});
}
var BEFORE_LAST_KINEMATICS_DELAY = 32;
var Engine = class {
  constructor(ctrl, args, key) {
    this.ctrl = ctrl;
    this.args = args;
    this.key = key;
    if (!this.state) {
      this.state = {};
      this.computeValues([0, 0]);
      this.computeInitial();
      if (this.init) this.init();
      this.reset();
    }
  }
  get state() {
    return this.ctrl.state[this.key];
  }
  set state(state) {
    this.ctrl.state[this.key] = state;
  }
  get shared() {
    return this.ctrl.state.shared;
  }
  get eventStore() {
    return this.ctrl.gestureEventStores[this.key];
  }
  get timeoutStore() {
    return this.ctrl.gestureTimeoutStores[this.key];
  }
  get config() {
    return this.ctrl.config[this.key];
  }
  get sharedConfig() {
    return this.ctrl.config.shared;
  }
  get handler() {
    return this.ctrl.handlers[this.key];
  }
  reset() {
    const {
      state,
      shared,
      ingKey,
      args
    } = this;
    shared[ingKey] = state._active = state.active = state._blocked = state._force = false;
    state._step = [false, false];
    state.intentional = false;
    state._movement = [0, 0];
    state._distance = [0, 0];
    state._direction = [0, 0];
    state._delta = [0, 0];
    state._bounds = [[-Infinity, Infinity], [-Infinity, Infinity]];
    state.args = args;
    state.axis = void 0;
    state.memo = void 0;
    state.elapsedTime = state.timeDelta = 0;
    state.direction = [0, 0];
    state.distance = [0, 0];
    state.overflow = [0, 0];
    state._movementBound = [false, false];
    state.velocity = [0, 0];
    state.movement = [0, 0];
    state.delta = [0, 0];
    state.timeStamp = 0;
  }
  start(event) {
    const state = this.state;
    const config = this.config;
    if (!state._active) {
      this.reset();
      this.computeInitial();
      state._active = true;
      state.target = event.target;
      state.currentTarget = event.currentTarget;
      state.lastOffset = config.from ? call(config.from, state) : state.offset;
      state.offset = state.lastOffset;
      state.startTime = state.timeStamp = event.timeStamp;
    }
  }
  computeValues(values) {
    const state = this.state;
    state._values = values;
    state.values = this.config.transform(values);
  }
  computeInitial() {
    const state = this.state;
    state._initial = state._values;
    state.initial = state.values;
  }
  compute(event) {
    const {
      state,
      config,
      shared
    } = this;
    state.args = this.args;
    let dt = 0;
    if (event) {
      state.event = event;
      if (config.preventDefault && event.cancelable) state.event.preventDefault();
      state.type = event.type;
      shared.touches = this.ctrl.pointerIds.size || this.ctrl.touchIds.size;
      shared.locked = !!document.pointerLockElement;
      Object.assign(shared, getEventDetails(event));
      shared.down = shared.pressed = shared.buttons % 2 === 1 || shared.touches > 0;
      dt = event.timeStamp - state.timeStamp;
      state.timeStamp = event.timeStamp;
      state.elapsedTime = state.timeStamp - state.startTime;
    }
    if (state._active) {
      const _absoluteDelta = state._delta.map(Math.abs);
      V.addTo(state._distance, _absoluteDelta);
    }
    if (this.axisIntent) this.axisIntent(event);
    const [_m0, _m1] = state._movement;
    const [t0, t1] = config.threshold;
    const {
      _step,
      values
    } = state;
    if (config.hasCustomTransform) {
      if (_step[0] === false) _step[0] = Math.abs(_m0) >= t0 && values[0];
      if (_step[1] === false) _step[1] = Math.abs(_m1) >= t1 && values[1];
    } else {
      if (_step[0] === false) _step[0] = Math.abs(_m0) >= t0 && Math.sign(_m0) * t0;
      if (_step[1] === false) _step[1] = Math.abs(_m1) >= t1 && Math.sign(_m1) * t1;
    }
    state.intentional = _step[0] !== false || _step[1] !== false;
    if (!state.intentional) return;
    const movement = [0, 0];
    if (config.hasCustomTransform) {
      const [v0, v1] = values;
      movement[0] = _step[0] !== false ? v0 - _step[0] : 0;
      movement[1] = _step[1] !== false ? v1 - _step[1] : 0;
    } else {
      movement[0] = _step[0] !== false ? _m0 - _step[0] : 0;
      movement[1] = _step[1] !== false ? _m1 - _step[1] : 0;
    }
    if (this.restrictToAxis && !state._blocked) this.restrictToAxis(movement);
    const previousOffset = state.offset;
    const gestureIsActive = state._active && !state._blocked || state.active;
    if (gestureIsActive) {
      state.first = state._active && !state.active;
      state.last = !state._active && state.active;
      state.active = shared[this.ingKey] = state._active;
      if (event) {
        if (state.first) {
          if ("bounds" in config) state._bounds = call(config.bounds, state);
          if (this.setup) this.setup();
        }
        state.movement = movement;
        this.computeOffset();
      }
    }
    const [ox, oy] = state.offset;
    const [[x0, x1], [y0, y1]] = state._bounds;
    state.overflow = [ox < x0 ? -1 : ox > x1 ? 1 : 0, oy < y0 ? -1 : oy > y1 ? 1 : 0];
    state._movementBound[0] = state.overflow[0] ? state._movementBound[0] === false ? state._movement[0] : state._movementBound[0] : false;
    state._movementBound[1] = state.overflow[1] ? state._movementBound[1] === false ? state._movement[1] : state._movementBound[1] : false;
    const rubberband2 = state._active ? config.rubberband || [0, 0] : [0, 0];
    state.offset = computeRubberband(state._bounds, state.offset, rubberband2);
    state.delta = V.sub(state.offset, previousOffset);
    this.computeMovement();
    if (gestureIsActive && (!state.last || dt > BEFORE_LAST_KINEMATICS_DELAY)) {
      state.delta = V.sub(state.offset, previousOffset);
      const absoluteDelta = state.delta.map(Math.abs);
      V.addTo(state.distance, absoluteDelta);
      state.direction = state.delta.map(Math.sign);
      state._direction = state._delta.map(Math.sign);
      if (!state.first && dt > 0) {
        state.velocity = [absoluteDelta[0] / dt, absoluteDelta[1] / dt];
        state.timeDelta = dt;
      }
    }
  }
  emit() {
    const state = this.state;
    const shared = this.shared;
    const config = this.config;
    if (!state._active) this.clean();
    if ((state._blocked || !state.intentional) && !state._force && !config.triggerAllEvents) return;
    const memo7 = this.handler(_objectSpread2(_objectSpread2(_objectSpread2({}, shared), state), {}, {
      [this.aliasKey]: state.values
    }));
    if (memo7 !== void 0) state.memo = memo7;
  }
  clean() {
    this.eventStore.clean();
    this.timeoutStore.clean();
  }
};
function selectAxis([dx, dy], threshold) {
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  if (absDx > absDy && absDx > threshold) {
    return "x";
  }
  if (absDy > absDx && absDy > threshold) {
    return "y";
  }
  return void 0;
}
var CoordinatesEngine = class extends Engine {
  constructor(...args) {
    super(...args);
    _defineProperty(this, "aliasKey", "xy");
  }
  reset() {
    super.reset();
    this.state.axis = void 0;
  }
  init() {
    this.state.offset = [0, 0];
    this.state.lastOffset = [0, 0];
  }
  computeOffset() {
    this.state.offset = V.add(this.state.lastOffset, this.state.movement);
  }
  computeMovement() {
    this.state.movement = V.sub(this.state.offset, this.state.lastOffset);
  }
  axisIntent(event) {
    const state = this.state;
    const config = this.config;
    if (!state.axis && event) {
      const threshold = typeof config.axisThreshold === "object" ? config.axisThreshold[getPointerType(event)] : config.axisThreshold;
      state.axis = selectAxis(state._movement, threshold);
    }
    state._blocked = (config.lockDirection || !!config.axis) && !state.axis || !!config.axis && config.axis !== state.axis;
  }
  restrictToAxis(v) {
    if (this.config.axis || this.config.lockDirection) {
      switch (this.state.axis) {
        case "x":
          v[1] = 0;
          break;
        case "y":
          v[0] = 0;
          break;
      }
    }
  }
};
var identity = (v) => v;
var DEFAULT_RUBBERBAND = 0.15;
var commonConfigResolver = {
  enabled(value = true) {
    return value;
  },
  eventOptions(value, _k, config) {
    return _objectSpread2(_objectSpread2({}, config.shared.eventOptions), value);
  },
  preventDefault(value = false) {
    return value;
  },
  triggerAllEvents(value = false) {
    return value;
  },
  rubberband(value = 0) {
    switch (value) {
      case true:
        return [DEFAULT_RUBBERBAND, DEFAULT_RUBBERBAND];
      case false:
        return [0, 0];
      default:
        return V.toVector(value);
    }
  },
  from(value) {
    if (typeof value === "function") return value;
    if (value != null) return V.toVector(value);
  },
  transform(value, _k, config) {
    const transform = value || config.shared.transform;
    this.hasCustomTransform = !!transform;
    if (process.env.NODE_ENV === "development") {
      const originalTransform = transform || identity;
      return (v) => {
        const r2 = originalTransform(v);
        if (!isFinite(r2[0]) || !isFinite(r2[1])) {
          console.warn(`[@use-gesture]: config.transform() must produce a valid result, but it was: [${r2[0]},${[1]}]`);
        }
        return r2;
      };
    }
    return transform || identity;
  },
  threshold(value) {
    return V.toVector(value, 0);
  }
};
if (process.env.NODE_ENV === "development") {
  Object.assign(commonConfigResolver, {
    domTarget(value) {
      if (value !== void 0) {
        throw Error(`[@use-gesture]: \`domTarget\` option has been renamed to \`target\`.`);
      }
      return NaN;
    },
    lockDirection(value) {
      if (value !== void 0) {
        throw Error(`[@use-gesture]: \`lockDirection\` option has been merged with \`axis\`. Use it as in \`{ axis: 'lock' }\``);
      }
      return NaN;
    },
    initial(value) {
      if (value !== void 0) {
        throw Error(`[@use-gesture]: \`initial\` option has been renamed to \`from\`.`);
      }
      return NaN;
    }
  });
}
var DEFAULT_AXIS_THRESHOLD = 0;
var coordinatesConfigResolver = _objectSpread2(_objectSpread2({}, commonConfigResolver), {}, {
  axis(_v, _k, {
    axis
  }) {
    this.lockDirection = axis === "lock";
    if (!this.lockDirection) return axis;
  },
  axisThreshold(value = DEFAULT_AXIS_THRESHOLD) {
    return value;
  },
  bounds(value = {}) {
    if (typeof value === "function") {
      return (state) => coordinatesConfigResolver.bounds(value(state));
    }
    if ("current" in value) {
      return () => value.current;
    }
    if (typeof HTMLElement === "function" && value instanceof HTMLElement) {
      return value;
    }
    const {
      left = -Infinity,
      right = Infinity,
      top = -Infinity,
      bottom = Infinity
    } = value;
    return [[left, right], [top, bottom]];
  }
});
var KEYS_DELTA_MAP = {
  ArrowRight: (displacement, factor = 1) => [displacement * factor, 0],
  ArrowLeft: (displacement, factor = 1) => [-1 * displacement * factor, 0],
  ArrowUp: (displacement, factor = 1) => [0, -1 * displacement * factor],
  ArrowDown: (displacement, factor = 1) => [0, displacement * factor]
};
var DragEngine = class extends CoordinatesEngine {
  constructor(...args) {
    super(...args);
    _defineProperty(this, "ingKey", "dragging");
  }
  reset() {
    super.reset();
    const state = this.state;
    state._pointerId = void 0;
    state._pointerActive = false;
    state._keyboardActive = false;
    state._preventScroll = false;
    state._delayed = false;
    state.swipe = [0, 0];
    state.tap = false;
    state.canceled = false;
    state.cancel = this.cancel.bind(this);
  }
  setup() {
    const state = this.state;
    if (state._bounds instanceof HTMLElement) {
      const boundRect = state._bounds.getBoundingClientRect();
      const targetRect = state.currentTarget.getBoundingClientRect();
      const _bounds = {
        left: boundRect.left - targetRect.left + state.offset[0],
        right: boundRect.right - targetRect.right + state.offset[0],
        top: boundRect.top - targetRect.top + state.offset[1],
        bottom: boundRect.bottom - targetRect.bottom + state.offset[1]
      };
      state._bounds = coordinatesConfigResolver.bounds(_bounds);
    }
  }
  cancel() {
    const state = this.state;
    if (state.canceled) return;
    state.canceled = true;
    state._active = false;
    setTimeout(() => {
      this.compute();
      this.emit();
    }, 0);
  }
  setActive() {
    this.state._active = this.state._pointerActive || this.state._keyboardActive;
  }
  clean() {
    this.pointerClean();
    this.state._pointerActive = false;
    this.state._keyboardActive = false;
    super.clean();
  }
  pointerDown(event) {
    const config = this.config;
    const state = this.state;
    if (event.buttons != null && (Array.isArray(config.pointerButtons) ? !config.pointerButtons.includes(event.buttons) : config.pointerButtons !== -1 && config.pointerButtons !== event.buttons)) return;
    const ctrlIds = this.ctrl.setEventIds(event);
    if (config.pointerCapture) {
      event.target.setPointerCapture(event.pointerId);
    }
    if (ctrlIds && ctrlIds.size > 1 && state._pointerActive) return;
    this.start(event);
    this.setupPointer(event);
    state._pointerId = pointerId(event);
    state._pointerActive = true;
    this.computeValues(pointerValues(event));
    this.computeInitial();
    if (config.preventScrollAxis && getPointerType(event) !== "mouse") {
      state._active = false;
      this.setupScrollPrevention(event);
    } else if (config.delay > 0) {
      this.setupDelayTrigger(event);
      if (config.triggerAllEvents) {
        this.compute(event);
        this.emit();
      }
    } else {
      this.startPointerDrag(event);
    }
  }
  startPointerDrag(event) {
    const state = this.state;
    state._active = true;
    state._preventScroll = true;
    state._delayed = false;
    this.compute(event);
    this.emit();
  }
  pointerMove(event) {
    const state = this.state;
    const config = this.config;
    if (!state._pointerActive) return;
    const id = pointerId(event);
    if (state._pointerId !== void 0 && id !== state._pointerId) return;
    const _values = pointerValues(event);
    if (document.pointerLockElement === event.target) {
      state._delta = [event.movementX, event.movementY];
    } else {
      state._delta = V.sub(_values, state._values);
      this.computeValues(_values);
    }
    V.addTo(state._movement, state._delta);
    this.compute(event);
    if (state._delayed && state.intentional) {
      this.timeoutStore.remove("dragDelay");
      state.active = false;
      this.startPointerDrag(event);
      return;
    }
    if (config.preventScrollAxis && !state._preventScroll) {
      if (state.axis) {
        if (state.axis === config.preventScrollAxis || config.preventScrollAxis === "xy") {
          state._active = false;
          this.clean();
          return;
        } else {
          this.timeoutStore.remove("startPointerDrag");
          this.startPointerDrag(event);
          return;
        }
      } else {
        return;
      }
    }
    this.emit();
  }
  pointerUp(event) {
    this.ctrl.setEventIds(event);
    try {
      if (this.config.pointerCapture && event.target.hasPointerCapture(event.pointerId)) {
        ;
        event.target.releasePointerCapture(event.pointerId);
      }
    } catch (_unused) {
      if (process.env.NODE_ENV === "development") {
        console.warn(`[@use-gesture]: If you see this message, it's likely that you're using an outdated version of \`@react-three/fiber\`. 

Please upgrade to the latest version.`);
      }
    }
    const state = this.state;
    const config = this.config;
    if (!state._active || !state._pointerActive) return;
    const id = pointerId(event);
    if (state._pointerId !== void 0 && id !== state._pointerId) return;
    this.state._pointerActive = false;
    this.setActive();
    this.compute(event);
    const [dx, dy] = state._distance;
    state.tap = dx <= config.tapsThreshold && dy <= config.tapsThreshold;
    if (state.tap && config.filterTaps) {
      state._force = true;
    } else {
      const [_dx, _dy] = state._delta;
      const [_mx, _my] = state._movement;
      const [svx, svy] = config.swipe.velocity;
      const [sx, sy] = config.swipe.distance;
      const sdt = config.swipe.duration;
      if (state.elapsedTime < sdt) {
        const _vx = Math.abs(_dx / state.timeDelta);
        const _vy = Math.abs(_dy / state.timeDelta);
        if (_vx > svx && Math.abs(_mx) > sx) state.swipe[0] = Math.sign(_dx);
        if (_vy > svy && Math.abs(_my) > sy) state.swipe[1] = Math.sign(_dy);
      }
    }
    this.emit();
  }
  pointerClick(event) {
    if (!this.state.tap && event.detail > 0) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  setupPointer(event) {
    const config = this.config;
    const device = config.device;
    if (process.env.NODE_ENV === "development") {
      try {
        if (device === "pointer" && config.preventScrollDelay === void 0) {
          const currentTarget = "uv" in event ? event.sourceEvent.currentTarget : event.currentTarget;
          const style = window.getComputedStyle(currentTarget);
          if (style.touchAction === "auto") {
            console.warn(`[@use-gesture]: The drag target has its \`touch-action\` style property set to \`auto\`. It is recommended to add \`touch-action: 'none'\` so that the drag gesture behaves correctly on touch-enabled devices. For more information read this: https://use-gesture.netlify.app/docs/extras/#touch-action.

This message will only show in development mode. It won't appear in production. If this is intended, you can ignore it.`, currentTarget);
          }
        }
      } catch (_unused2) {
      }
    }
    if (config.pointerLock) {
      event.currentTarget.requestPointerLock();
    }
    if (!config.pointerCapture) {
      this.eventStore.add(this.sharedConfig.window, device, "change", this.pointerMove.bind(this));
      this.eventStore.add(this.sharedConfig.window, device, "end", this.pointerUp.bind(this));
      this.eventStore.add(this.sharedConfig.window, device, "cancel", this.pointerUp.bind(this));
    }
  }
  pointerClean() {
    if (this.config.pointerLock && document.pointerLockElement === this.state.currentTarget) {
      document.exitPointerLock();
    }
  }
  preventScroll(event) {
    if (this.state._preventScroll && event.cancelable) {
      event.preventDefault();
    }
  }
  setupScrollPrevention(event) {
    this.state._preventScroll = false;
    persistEvent(event);
    const remove = this.eventStore.add(this.sharedConfig.window, "touch", "change", this.preventScroll.bind(this), {
      passive: false
    });
    this.eventStore.add(this.sharedConfig.window, "touch", "end", remove);
    this.eventStore.add(this.sharedConfig.window, "touch", "cancel", remove);
    this.timeoutStore.add("startPointerDrag", this.startPointerDrag.bind(this), this.config.preventScrollDelay, event);
  }
  setupDelayTrigger(event) {
    this.state._delayed = true;
    this.timeoutStore.add("dragDelay", () => {
      this.state._step = [0, 0];
      this.startPointerDrag(event);
    }, this.config.delay);
  }
  keyDown(event) {
    const deltaFn = KEYS_DELTA_MAP[event.key];
    if (deltaFn) {
      const state = this.state;
      const factor = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
      this.start(event);
      state._delta = deltaFn(this.config.keyboardDisplacement, factor);
      state._keyboardActive = true;
      V.addTo(state._movement, state._delta);
      this.compute(event);
      this.emit();
    }
  }
  keyUp(event) {
    if (!(event.key in KEYS_DELTA_MAP)) return;
    this.state._keyboardActive = false;
    this.setActive();
    this.compute(event);
    this.emit();
  }
  bind(bindFunction) {
    const device = this.config.device;
    bindFunction(device, "start", this.pointerDown.bind(this));
    if (this.config.pointerCapture) {
      bindFunction(device, "change", this.pointerMove.bind(this));
      bindFunction(device, "end", this.pointerUp.bind(this));
      bindFunction(device, "cancel", this.pointerUp.bind(this));
      bindFunction("lostPointerCapture", "", this.pointerUp.bind(this));
    }
    if (this.config.keys) {
      bindFunction("key", "down", this.keyDown.bind(this));
      bindFunction("key", "up", this.keyUp.bind(this));
    }
    if (this.config.filterTaps) {
      bindFunction("click", "", this.pointerClick.bind(this), {
        capture: true,
        passive: false
      });
    }
  }
};
function persistEvent(event) {
  "persist" in event && typeof event.persist === "function" && event.persist();
}
var isBrowser = typeof window !== "undefined" && window.document && window.document.createElement;
function supportsTouchEvents() {
  return isBrowser && "ontouchstart" in window;
}
function isTouchScreen() {
  return supportsTouchEvents() || isBrowser && window.navigator.maxTouchPoints > 1;
}
function supportsPointerEvents() {
  return isBrowser && "onpointerdown" in window;
}
function supportsPointerLock() {
  return isBrowser && "exitPointerLock" in window.document;
}
function supportsGestureEvents() {
  try {
    return "constructor" in GestureEvent;
  } catch (e) {
    return false;
  }
}
var SUPPORT = {
  isBrowser,
  gesture: supportsGestureEvents(),
  touch: supportsTouchEvents(),
  touchscreen: isTouchScreen(),
  pointer: supportsPointerEvents(),
  pointerLock: supportsPointerLock()
};
var DEFAULT_PREVENT_SCROLL_DELAY = 250;
var DEFAULT_DRAG_DELAY = 180;
var DEFAULT_SWIPE_VELOCITY = 0.5;
var DEFAULT_SWIPE_DISTANCE = 50;
var DEFAULT_SWIPE_DURATION = 250;
var DEFAULT_KEYBOARD_DISPLACEMENT = 10;
var DEFAULT_DRAG_AXIS_THRESHOLD = {
  mouse: 0,
  touch: 0,
  pen: 8
};
var dragConfigResolver = _objectSpread2(_objectSpread2({}, coordinatesConfigResolver), {}, {
  device(_v, _k, {
    pointer: {
      touch = false,
      lock = false,
      mouse = false
    } = {}
  }) {
    this.pointerLock = lock && SUPPORT.pointerLock;
    if (SUPPORT.touch && touch) return "touch";
    if (this.pointerLock) return "mouse";
    if (SUPPORT.pointer && !mouse) return "pointer";
    if (SUPPORT.touch) return "touch";
    return "mouse";
  },
  preventScrollAxis(value, _k, {
    preventScroll
  }) {
    this.preventScrollDelay = typeof preventScroll === "number" ? preventScroll : preventScroll || preventScroll === void 0 && value ? DEFAULT_PREVENT_SCROLL_DELAY : void 0;
    if (!SUPPORT.touchscreen || preventScroll === false) return void 0;
    return value ? value : preventScroll !== void 0 ? "y" : void 0;
  },
  pointerCapture(_v, _k, {
    pointer: {
      capture = true,
      buttons = 1,
      keys = true
    } = {}
  }) {
    this.pointerButtons = buttons;
    this.keys = keys;
    return !this.pointerLock && this.device === "pointer" && capture;
  },
  threshold(value, _k, {
    filterTaps = false,
    tapsThreshold = 3,
    axis = void 0
  }) {
    const threshold = V.toVector(value, filterTaps ? tapsThreshold : axis ? 1 : 0);
    this.filterTaps = filterTaps;
    this.tapsThreshold = tapsThreshold;
    return threshold;
  },
  swipe({
    velocity = DEFAULT_SWIPE_VELOCITY,
    distance = DEFAULT_SWIPE_DISTANCE,
    duration = DEFAULT_SWIPE_DURATION
  } = {}) {
    return {
      velocity: this.transform(V.toVector(velocity)),
      distance: this.transform(V.toVector(distance)),
      duration
    };
  },
  delay(value = 0) {
    switch (value) {
      case true:
        return DEFAULT_DRAG_DELAY;
      case false:
        return 0;
      default:
        return value;
    }
  },
  axisThreshold(value) {
    if (!value) return DEFAULT_DRAG_AXIS_THRESHOLD;
    return _objectSpread2(_objectSpread2({}, DEFAULT_DRAG_AXIS_THRESHOLD), value);
  },
  keyboardDisplacement(value = DEFAULT_KEYBOARD_DISPLACEMENT) {
    return value;
  }
});
if (process.env.NODE_ENV === "development") {
  Object.assign(dragConfigResolver, {
    useTouch(value) {
      if (value !== void 0) {
        throw Error(`[@use-gesture]: \`useTouch\` option has been renamed to \`pointer.touch\`. Use it as in \`{ pointer: { touch: true } }\`.`);
      }
      return NaN;
    },
    experimental_preventWindowScrollY(value) {
      if (value !== void 0) {
        throw Error(`[@use-gesture]: \`experimental_preventWindowScrollY\` option has been renamed to \`preventScroll\`.`);
      }
      return NaN;
    },
    swipeVelocity(value) {
      if (value !== void 0) {
        throw Error(`[@use-gesture]: \`swipeVelocity\` option has been renamed to \`swipe.velocity\`. Use it as in \`{ swipe: { velocity: 0.5 } }\`.`);
      }
      return NaN;
    },
    swipeDistance(value) {
      if (value !== void 0) {
        throw Error(`[@use-gesture]: \`swipeDistance\` option has been renamed to \`swipe.distance\`. Use it as in \`{ swipe: { distance: 50 } }\`.`);
      }
      return NaN;
    },
    swipeDuration(value) {
      if (value !== void 0) {
        throw Error(`[@use-gesture]: \`swipeDuration\` option has been renamed to \`swipe.duration\`. Use it as in \`{ swipe: { duration: 250 } }\`.`);
      }
      return NaN;
    }
  });
}
function clampStateInternalMovementToBounds(state) {
  const [ox, oy] = state.overflow;
  const [dx, dy] = state._delta;
  const [dirx, diry] = state._direction;
  if (ox < 0 && dx > 0 && dirx < 0 || ox > 0 && dx < 0 && dirx > 0) {
    state._movement[0] = state._movementBound[0];
  }
  if (oy < 0 && dy > 0 && diry < 0 || oy > 0 && dy < 0 && diry > 0) {
    state._movement[1] = state._movementBound[1];
  }
}
var SCALE_ANGLE_RATIO_INTENT_DEG = 30;
var PINCH_WHEEL_RATIO = 100;
var PinchEngine = class extends Engine {
  constructor(...args) {
    super(...args);
    _defineProperty(this, "ingKey", "pinching");
    _defineProperty(this, "aliasKey", "da");
  }
  init() {
    this.state.offset = [1, 0];
    this.state.lastOffset = [1, 0];
    this.state._pointerEvents = /* @__PURE__ */ new Map();
  }
  reset() {
    super.reset();
    const state = this.state;
    state._touchIds = [];
    state.canceled = false;
    state.cancel = this.cancel.bind(this);
    state.turns = 0;
  }
  computeOffset() {
    const {
      type,
      movement,
      lastOffset
    } = this.state;
    if (type === "wheel") {
      this.state.offset = V.add(movement, lastOffset);
    } else {
      this.state.offset = [(1 + movement[0]) * lastOffset[0], movement[1] + lastOffset[1]];
    }
  }
  computeMovement() {
    const {
      offset: offset3,
      lastOffset
    } = this.state;
    this.state.movement = [offset3[0] / lastOffset[0], offset3[1] - lastOffset[1]];
  }
  axisIntent() {
    const state = this.state;
    const [_m0, _m1] = state._movement;
    if (!state.axis) {
      const axisMovementDifference = Math.abs(_m0) * SCALE_ANGLE_RATIO_INTENT_DEG - Math.abs(_m1);
      if (axisMovementDifference < 0) state.axis = "angle";
      else if (axisMovementDifference > 0) state.axis = "scale";
    }
  }
  restrictToAxis(v) {
    if (this.config.lockDirection) {
      if (this.state.axis === "scale") v[1] = 0;
      else if (this.state.axis === "angle") v[0] = 0;
    }
  }
  cancel() {
    const state = this.state;
    if (state.canceled) return;
    setTimeout(() => {
      state.canceled = true;
      state._active = false;
      this.compute();
      this.emit();
    }, 0);
  }
  touchStart(event) {
    this.ctrl.setEventIds(event);
    const state = this.state;
    const ctrlTouchIds = this.ctrl.touchIds;
    if (state._active) {
      if (state._touchIds.every((id) => ctrlTouchIds.has(id))) return;
    }
    if (ctrlTouchIds.size < 2) return;
    this.start(event);
    state._touchIds = Array.from(ctrlTouchIds).slice(0, 2);
    const payload = touchDistanceAngle(event, state._touchIds);
    if (!payload) return;
    this.pinchStart(event, payload);
  }
  pointerStart(event) {
    if (event.buttons != null && event.buttons % 2 !== 1) return;
    this.ctrl.setEventIds(event);
    event.target.setPointerCapture(event.pointerId);
    const state = this.state;
    const _pointerEvents = state._pointerEvents;
    const ctrlPointerIds = this.ctrl.pointerIds;
    if (state._active) {
      if (Array.from(_pointerEvents.keys()).every((id) => ctrlPointerIds.has(id))) return;
    }
    if (_pointerEvents.size < 2) {
      _pointerEvents.set(event.pointerId, event);
    }
    if (state._pointerEvents.size < 2) return;
    this.start(event);
    const payload = distanceAngle(...Array.from(_pointerEvents.values()));
    if (!payload) return;
    this.pinchStart(event, payload);
  }
  pinchStart(event, payload) {
    const state = this.state;
    state.origin = payload.origin;
    this.computeValues([payload.distance, payload.angle]);
    this.computeInitial();
    this.compute(event);
    this.emit();
  }
  touchMove(event) {
    if (!this.state._active) return;
    const payload = touchDistanceAngle(event, this.state._touchIds);
    if (!payload) return;
    this.pinchMove(event, payload);
  }
  pointerMove(event) {
    const _pointerEvents = this.state._pointerEvents;
    if (_pointerEvents.has(event.pointerId)) {
      _pointerEvents.set(event.pointerId, event);
    }
    if (!this.state._active) return;
    const payload = distanceAngle(...Array.from(_pointerEvents.values()));
    if (!payload) return;
    this.pinchMove(event, payload);
  }
  pinchMove(event, payload) {
    const state = this.state;
    const prev_a = state._values[1];
    const delta_a = payload.angle - prev_a;
    let delta_turns = 0;
    if (Math.abs(delta_a) > 270) delta_turns += Math.sign(delta_a);
    this.computeValues([payload.distance, payload.angle - 360 * delta_turns]);
    state.origin = payload.origin;
    state.turns = delta_turns;
    state._movement = [state._values[0] / state._initial[0] - 1, state._values[1] - state._initial[1]];
    this.compute(event);
    this.emit();
  }
  touchEnd(event) {
    this.ctrl.setEventIds(event);
    if (!this.state._active) return;
    if (this.state._touchIds.some((id) => !this.ctrl.touchIds.has(id))) {
      this.state._active = false;
      this.compute(event);
      this.emit();
    }
  }
  pointerEnd(event) {
    const state = this.state;
    this.ctrl.setEventIds(event);
    try {
      event.target.releasePointerCapture(event.pointerId);
    } catch (_unused) {
    }
    if (state._pointerEvents.has(event.pointerId)) {
      state._pointerEvents.delete(event.pointerId);
    }
    if (!state._active) return;
    if (state._pointerEvents.size < 2) {
      state._active = false;
      this.compute(event);
      this.emit();
    }
  }
  gestureStart(event) {
    if (event.cancelable) event.preventDefault();
    const state = this.state;
    if (state._active) return;
    this.start(event);
    this.computeValues([event.scale, event.rotation]);
    state.origin = [event.clientX, event.clientY];
    this.compute(event);
    this.emit();
  }
  gestureMove(event) {
    if (event.cancelable) event.preventDefault();
    if (!this.state._active) return;
    const state = this.state;
    this.computeValues([event.scale, event.rotation]);
    state.origin = [event.clientX, event.clientY];
    const _previousMovement = state._movement;
    state._movement = [event.scale - 1, event.rotation];
    state._delta = V.sub(state._movement, _previousMovement);
    this.compute(event);
    this.emit();
  }
  gestureEnd(event) {
    if (!this.state._active) return;
    this.state._active = false;
    this.compute(event);
    this.emit();
  }
  wheel(event) {
    const modifierKey = this.config.modifierKey;
    if (modifierKey && (Array.isArray(modifierKey) ? !modifierKey.find((k) => event[k]) : !event[modifierKey])) return;
    if (!this.state._active) this.wheelStart(event);
    else this.wheelChange(event);
    this.timeoutStore.add("wheelEnd", this.wheelEnd.bind(this));
  }
  wheelStart(event) {
    this.start(event);
    this.wheelChange(event);
  }
  wheelChange(event) {
    const isR3f = "uv" in event;
    if (!isR3f) {
      if (event.cancelable) {
        event.preventDefault();
      }
      if (process.env.NODE_ENV === "development" && !event.defaultPrevented) {
        console.warn(`[@use-gesture]: To properly support zoom on trackpads, try using the \`target\` option.

This message will only appear in development mode.`);
      }
    }
    const state = this.state;
    state._delta = [-wheelValues(event)[1] / PINCH_WHEEL_RATIO * state.offset[0], 0];
    V.addTo(state._movement, state._delta);
    clampStateInternalMovementToBounds(state);
    this.state.origin = [event.clientX, event.clientY];
    this.compute(event);
    this.emit();
  }
  wheelEnd() {
    if (!this.state._active) return;
    this.state._active = false;
    this.compute();
    this.emit();
  }
  bind(bindFunction) {
    const device = this.config.device;
    if (!!device) {
      bindFunction(device, "start", this[device + "Start"].bind(this));
      bindFunction(device, "change", this[device + "Move"].bind(this));
      bindFunction(device, "end", this[device + "End"].bind(this));
      bindFunction(device, "cancel", this[device + "End"].bind(this));
      bindFunction("lostPointerCapture", "", this[device + "End"].bind(this));
    }
    if (this.config.pinchOnWheel) {
      bindFunction("wheel", "", this.wheel.bind(this), {
        passive: false
      });
    }
  }
};
var pinchConfigResolver = _objectSpread2(_objectSpread2({}, commonConfigResolver), {}, {
  device(_v, _k, {
    shared,
    pointer: {
      touch = false
    } = {}
  }) {
    const sharedConfig = shared;
    if (sharedConfig.target && !SUPPORT.touch && SUPPORT.gesture) return "gesture";
    if (SUPPORT.touch && touch) return "touch";
    if (SUPPORT.touchscreen) {
      if (SUPPORT.pointer) return "pointer";
      if (SUPPORT.touch) return "touch";
    }
  },
  bounds(_v, _k, {
    scaleBounds = {},
    angleBounds = {}
  }) {
    const _scaleBounds = (state) => {
      const D = assignDefault(call(scaleBounds, state), {
        min: -Infinity,
        max: Infinity
      });
      return [D.min, D.max];
    };
    const _angleBounds = (state) => {
      const A = assignDefault(call(angleBounds, state), {
        min: -Infinity,
        max: Infinity
      });
      return [A.min, A.max];
    };
    if (typeof scaleBounds !== "function" && typeof angleBounds !== "function") return [_scaleBounds(), _angleBounds()];
    return (state) => [_scaleBounds(state), _angleBounds(state)];
  },
  threshold(value, _k, config) {
    this.lockDirection = config.axis === "lock";
    const threshold = V.toVector(value, this.lockDirection ? [0.1, 3] : 0);
    return threshold;
  },
  modifierKey(value) {
    if (value === void 0) return "ctrlKey";
    return value;
  },
  pinchOnWheel(value = true) {
    return value;
  }
});
var MoveEngine = class extends CoordinatesEngine {
  constructor(...args) {
    super(...args);
    _defineProperty(this, "ingKey", "moving");
  }
  move(event) {
    if (this.config.mouseOnly && event.pointerType !== "mouse") return;
    if (!this.state._active) this.moveStart(event);
    else this.moveChange(event);
    this.timeoutStore.add("moveEnd", this.moveEnd.bind(this));
  }
  moveStart(event) {
    this.start(event);
    this.computeValues(pointerValues(event));
    this.compute(event);
    this.computeInitial();
    this.emit();
  }
  moveChange(event) {
    if (!this.state._active) return;
    const values = pointerValues(event);
    const state = this.state;
    state._delta = V.sub(values, state._values);
    V.addTo(state._movement, state._delta);
    this.computeValues(values);
    this.compute(event);
    this.emit();
  }
  moveEnd(event) {
    if (!this.state._active) return;
    this.state._active = false;
    this.compute(event);
    this.emit();
  }
  bind(bindFunction) {
    bindFunction("pointer", "change", this.move.bind(this));
    bindFunction("pointer", "leave", this.moveEnd.bind(this));
  }
};
var moveConfigResolver = _objectSpread2(_objectSpread2({}, coordinatesConfigResolver), {}, {
  mouseOnly: (value = true) => value
});
var ScrollEngine = class extends CoordinatesEngine {
  constructor(...args) {
    super(...args);
    _defineProperty(this, "ingKey", "scrolling");
  }
  scroll(event) {
    if (!this.state._active) this.start(event);
    this.scrollChange(event);
    this.timeoutStore.add("scrollEnd", this.scrollEnd.bind(this));
  }
  scrollChange(event) {
    if (event.cancelable) event.preventDefault();
    const state = this.state;
    const values = scrollValues(event);
    state._delta = V.sub(values, state._values);
    V.addTo(state._movement, state._delta);
    this.computeValues(values);
    this.compute(event);
    this.emit();
  }
  scrollEnd() {
    if (!this.state._active) return;
    this.state._active = false;
    this.compute();
    this.emit();
  }
  bind(bindFunction) {
    bindFunction("scroll", "", this.scroll.bind(this));
  }
};
var scrollConfigResolver = coordinatesConfigResolver;
var WheelEngine = class extends CoordinatesEngine {
  constructor(...args) {
    super(...args);
    _defineProperty(this, "ingKey", "wheeling");
  }
  wheel(event) {
    if (!this.state._active) this.start(event);
    this.wheelChange(event);
    this.timeoutStore.add("wheelEnd", this.wheelEnd.bind(this));
  }
  wheelChange(event) {
    const state = this.state;
    state._delta = wheelValues(event);
    V.addTo(state._movement, state._delta);
    clampStateInternalMovementToBounds(state);
    this.compute(event);
    this.emit();
  }
  wheelEnd() {
    if (!this.state._active) return;
    this.state._active = false;
    this.compute();
    this.emit();
  }
  bind(bindFunction) {
    bindFunction("wheel", "", this.wheel.bind(this));
  }
};
var wheelConfigResolver = coordinatesConfigResolver;
var HoverEngine = class extends CoordinatesEngine {
  constructor(...args) {
    super(...args);
    _defineProperty(this, "ingKey", "hovering");
  }
  enter(event) {
    if (this.config.mouseOnly && event.pointerType !== "mouse") return;
    this.start(event);
    this.computeValues(pointerValues(event));
    this.compute(event);
    this.emit();
  }
  leave(event) {
    if (this.config.mouseOnly && event.pointerType !== "mouse") return;
    const state = this.state;
    if (!state._active) return;
    state._active = false;
    const values = pointerValues(event);
    state._movement = state._delta = V.sub(values, state._values);
    this.computeValues(values);
    this.compute(event);
    state.delta = state.movement;
    this.emit();
  }
  bind(bindFunction) {
    bindFunction("pointer", "enter", this.enter.bind(this));
    bindFunction("pointer", "leave", this.leave.bind(this));
  }
};
var hoverConfigResolver = _objectSpread2(_objectSpread2({}, coordinatesConfigResolver), {}, {
  mouseOnly: (value = true) => value
});
var EngineMap = /* @__PURE__ */ new Map();
var ConfigResolverMap = /* @__PURE__ */ new Map();
function registerAction(action) {
  EngineMap.set(action.key, action.engine);
  ConfigResolverMap.set(action.key, action.resolver);
}
var dragAction = {
  key: "drag",
  engine: DragEngine,
  resolver: dragConfigResolver
};
var hoverAction = {
  key: "hover",
  engine: HoverEngine,
  resolver: hoverConfigResolver
};
var moveAction = {
  key: "move",
  engine: MoveEngine,
  resolver: moveConfigResolver
};
var pinchAction = {
  key: "pinch",
  engine: PinchEngine,
  resolver: pinchConfigResolver
};
var scrollAction = {
  key: "scroll",
  engine: ScrollEngine,
  resolver: scrollConfigResolver
};
var wheelAction = {
  key: "wheel",
  engine: WheelEngine,
  resolver: wheelConfigResolver
};

// ../../node_modules/.pnpm/@use-gesture+core@10.3.1/node_modules/@use-gesture/core/dist/use-gesture-core.esm.js
function _objectWithoutPropertiesLoose(source, excluded) {
  if (source == null) return {};
  var target = {};
  var sourceKeys = Object.keys(source);
  var key, i;
  for (i = 0; i < sourceKeys.length; i++) {
    key = sourceKeys[i];
    if (excluded.indexOf(key) >= 0) continue;
    target[key] = source[key];
  }
  return target;
}
function _objectWithoutProperties(source, excluded) {
  if (source == null) return {};
  var target = _objectWithoutPropertiesLoose(source, excluded);
  var key, i;
  if (Object.getOwnPropertySymbols) {
    var sourceSymbolKeys = Object.getOwnPropertySymbols(source);
    for (i = 0; i < sourceSymbolKeys.length; i++) {
      key = sourceSymbolKeys[i];
      if (excluded.indexOf(key) >= 0) continue;
      if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
      target[key] = source[key];
    }
  }
  return target;
}
var sharedConfigResolver = {
  target(value) {
    if (value) {
      return () => "current" in value ? value.current : value;
    }
    return void 0;
  },
  enabled(value = true) {
    return value;
  },
  window(value = SUPPORT.isBrowser ? window : void 0) {
    return value;
  },
  eventOptions({
    passive = true,
    capture = false
  } = {}) {
    return {
      passive,
      capture
    };
  },
  transform(value) {
    return value;
  }
};
var _excluded = ["target", "eventOptions", "window", "enabled", "transform"];
function resolveWith(config = {}, resolvers) {
  const result = {};
  for (const [key, resolver] of Object.entries(resolvers)) {
    switch (typeof resolver) {
      case "function":
        if (process.env.NODE_ENV === "development") {
          const r2 = resolver.call(result, config[key], key, config);
          if (!Number.isNaN(r2)) result[key] = r2;
        } else {
          result[key] = resolver.call(result, config[key], key, config);
        }
        break;
      case "object":
        result[key] = resolveWith(config[key], resolver);
        break;
      case "boolean":
        if (resolver) result[key] = config[key];
        break;
    }
  }
  return result;
}
function parse(newConfig, gestureKey, _config = {}) {
  const _ref = newConfig, {
    target,
    eventOptions,
    window: window2,
    enabled,
    transform
  } = _ref, rest = _objectWithoutProperties(_ref, _excluded);
  _config.shared = resolveWith({
    target,
    eventOptions,
    window: window2,
    enabled,
    transform
  }, sharedConfigResolver);
  if (gestureKey) {
    const resolver = ConfigResolverMap.get(gestureKey);
    _config[gestureKey] = resolveWith(_objectSpread2({
      shared: _config.shared
    }, rest), resolver);
  } else {
    for (const key in rest) {
      const resolver = ConfigResolverMap.get(key);
      if (resolver) {
        _config[key] = resolveWith(_objectSpread2({
          shared: _config.shared
        }, rest[key]), resolver);
      } else if (process.env.NODE_ENV === "development") {
        if (!["drag", "pinch", "scroll", "wheel", "move", "hover"].includes(key)) {
          if (key === "domTarget") {
            throw Error(`[@use-gesture]: \`domTarget\` option has been renamed to \`target\`.`);
          }
          console.warn(`[@use-gesture]: Unknown config key \`${key}\` was used. Please read the documentation for further information.`);
        }
      }
    }
  }
  return _config;
}
var EventStore = class {
  constructor(ctrl, gestureKey) {
    _defineProperty(this, "_listeners", /* @__PURE__ */ new Set());
    this._ctrl = ctrl;
    this._gestureKey = gestureKey;
  }
  add(element, device, action, handler, options) {
    const listeners = this._listeners;
    const type = toDomEventType(device, action);
    const _options = this._gestureKey ? this._ctrl.config[this._gestureKey].eventOptions : {};
    const eventOptions = _objectSpread2(_objectSpread2({}, _options), options);
    element.addEventListener(type, handler, eventOptions);
    const remove = () => {
      element.removeEventListener(type, handler, eventOptions);
      listeners.delete(remove);
    };
    listeners.add(remove);
    return remove;
  }
  clean() {
    this._listeners.forEach((remove) => remove());
    this._listeners.clear();
  }
};
var TimeoutStore = class {
  constructor() {
    _defineProperty(this, "_timeouts", /* @__PURE__ */ new Map());
  }
  add(key, callback, ms = 140, ...args) {
    this.remove(key);
    this._timeouts.set(key, window.setTimeout(callback, ms, ...args));
  }
  remove(key) {
    const timeout = this._timeouts.get(key);
    if (timeout) window.clearTimeout(timeout);
  }
  clean() {
    this._timeouts.forEach((timeout) => void window.clearTimeout(timeout));
    this._timeouts.clear();
  }
};
var Controller = class {
  constructor(handlers) {
    _defineProperty(this, "gestures", /* @__PURE__ */ new Set());
    _defineProperty(this, "_targetEventStore", new EventStore(this));
    _defineProperty(this, "gestureEventStores", {});
    _defineProperty(this, "gestureTimeoutStores", {});
    _defineProperty(this, "handlers", {});
    _defineProperty(this, "config", {});
    _defineProperty(this, "pointerIds", /* @__PURE__ */ new Set());
    _defineProperty(this, "touchIds", /* @__PURE__ */ new Set());
    _defineProperty(this, "state", {
      shared: {
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false
      }
    });
    resolveGestures(this, handlers);
  }
  setEventIds(event) {
    if (isTouch(event)) {
      this.touchIds = new Set(touchIds(event));
      return this.touchIds;
    } else if ("pointerId" in event) {
      if (event.type === "pointerup" || event.type === "pointercancel") this.pointerIds.delete(event.pointerId);
      else if (event.type === "pointerdown") this.pointerIds.add(event.pointerId);
      return this.pointerIds;
    }
  }
  applyHandlers(handlers, nativeHandlers) {
    this.handlers = handlers;
    this.nativeHandlers = nativeHandlers;
  }
  applyConfig(config, gestureKey) {
    this.config = parse(config, gestureKey, this.config);
  }
  clean() {
    this._targetEventStore.clean();
    for (const key of this.gestures) {
      this.gestureEventStores[key].clean();
      this.gestureTimeoutStores[key].clean();
    }
  }
  effect() {
    if (this.config.shared.target) this.bind();
    return () => this._targetEventStore.clean();
  }
  bind(...args) {
    const sharedConfig = this.config.shared;
    const props = {};
    let target;
    if (sharedConfig.target) {
      target = sharedConfig.target();
      if (!target) return;
    }
    if (sharedConfig.enabled) {
      for (const gestureKey of this.gestures) {
        const gestureConfig = this.config[gestureKey];
        const bindFunction = bindToProps(props, gestureConfig.eventOptions, !!target);
        if (gestureConfig.enabled) {
          const Engine2 = EngineMap.get(gestureKey);
          new Engine2(this, args, gestureKey).bind(bindFunction);
        }
      }
      const nativeBindFunction = bindToProps(props, sharedConfig.eventOptions, !!target);
      for (const eventKey in this.nativeHandlers) {
        nativeBindFunction(eventKey, "", (event) => this.nativeHandlers[eventKey](_objectSpread2(_objectSpread2({}, this.state.shared), {}, {
          event,
          args
        })), void 0, true);
      }
    }
    for (const handlerProp in props) {
      props[handlerProp] = chain(...props[handlerProp]);
    }
    if (!target) return props;
    for (const handlerProp in props) {
      const {
        device,
        capture,
        passive
      } = parseProp(handlerProp);
      this._targetEventStore.add(target, device, "", props[handlerProp], {
        capture,
        passive
      });
    }
  }
};
function setupGesture(ctrl, gestureKey) {
  ctrl.gestures.add(gestureKey);
  ctrl.gestureEventStores[gestureKey] = new EventStore(ctrl, gestureKey);
  ctrl.gestureTimeoutStores[gestureKey] = new TimeoutStore();
}
function resolveGestures(ctrl, internalHandlers) {
  if (internalHandlers.drag) setupGesture(ctrl, "drag");
  if (internalHandlers.wheel) setupGesture(ctrl, "wheel");
  if (internalHandlers.scroll) setupGesture(ctrl, "scroll");
  if (internalHandlers.move) setupGesture(ctrl, "move");
  if (internalHandlers.pinch) setupGesture(ctrl, "pinch");
  if (internalHandlers.hover) setupGesture(ctrl, "hover");
}
var bindToProps = (props, eventOptions, withPassiveOption) => (device, action, handler, options = {}, isNative = false) => {
  var _options$capture, _options$passive;
  const capture = (_options$capture = options.capture) !== null && _options$capture !== void 0 ? _options$capture : eventOptions.capture;
  const passive = (_options$passive = options.passive) !== null && _options$passive !== void 0 ? _options$passive : eventOptions.passive;
  let handlerProp = isNative ? device : toHandlerProp(device, action, capture);
  if (withPassiveOption && passive) handlerProp += "Passive";
  props[handlerProp] = props[handlerProp] || [];
  props[handlerProp].push(handler);
};
var RE_NOT_NATIVE = /^on(Drag|Wheel|Scroll|Move|Pinch|Hover)/;
function sortHandlers(_handlers) {
  const native = {};
  const handlers = {};
  const actions = /* @__PURE__ */ new Set();
  for (let key in _handlers) {
    if (RE_NOT_NATIVE.test(key)) {
      actions.add(RegExp.lastMatch);
      handlers[key] = _handlers[key];
    } else {
      native[key] = _handlers[key];
    }
  }
  return [handlers, native, actions];
}
function registerGesture(actions, handlers, handlerKey, key, internalHandlers, config) {
  if (!actions.has(handlerKey)) return;
  if (!EngineMap.has(key)) {
    if (process.env.NODE_ENV === "development") {
      console.warn(`[@use-gesture]: You've created a custom handler that that uses the \`${key}\` gesture but isn't properly configured.

Please add \`${key}Action\` when creating your handler.`);
    }
    return;
  }
  const startKey = handlerKey + "Start";
  const endKey = handlerKey + "End";
  const fn = (state) => {
    let memo7 = void 0;
    if (state.first && startKey in handlers) handlers[startKey](state);
    if (handlerKey in handlers) memo7 = handlers[handlerKey](state);
    if (state.last && endKey in handlers) handlers[endKey](state);
    return memo7;
  };
  internalHandlers[key] = fn;
  config[key] = config[key] || {};
}
function parseMergedHandlers(mergedHandlers, mergedConfig) {
  const [handlers, nativeHandlers, actions] = sortHandlers(mergedHandlers);
  const internalHandlers = {};
  registerGesture(actions, handlers, "onDrag", "drag", internalHandlers, mergedConfig);
  registerGesture(actions, handlers, "onWheel", "wheel", internalHandlers, mergedConfig);
  registerGesture(actions, handlers, "onScroll", "scroll", internalHandlers, mergedConfig);
  registerGesture(actions, handlers, "onPinch", "pinch", internalHandlers, mergedConfig);
  registerGesture(actions, handlers, "onMove", "move", internalHandlers, mergedConfig);
  registerGesture(actions, handlers, "onHover", "hover", internalHandlers, mergedConfig);
  return {
    handlers: internalHandlers,
    config: mergedConfig,
    nativeHandlers
  };
}

// ../../node_modules/.pnpm/@use-gesture+react@10.3.1_react@19.2.0/node_modules/@use-gesture/react/dist/use-gesture-react.esm.js
function useRecognizers(handlers, config = {}, gestureKey, nativeHandlers) {
  const ctrl = React.useMemo(() => new Controller(handlers), []);
  ctrl.applyHandlers(handlers, nativeHandlers);
  ctrl.applyConfig(config, gestureKey);
  React.useEffect(ctrl.effect.bind(ctrl));
  React.useEffect(() => {
    return ctrl.clean.bind(ctrl);
  }, []);
  if (config.target === void 0) {
    return ctrl.bind.bind(ctrl);
  }
  return void 0;
}
function createUseGesture(actions) {
  actions.forEach(registerAction);
  return function useGesture2(_handlers, _config) {
    const {
      handlers,
      nativeHandlers,
      config
    } = parseMergedHandlers(_handlers, _config || {});
    return useRecognizers(handlers, config, void 0, nativeHandlers);
  };
}
function useGesture(handlers, config) {
  const hook = createUseGesture([dragAction, pinchAction, scrollAction, wheelAction, moveAction, hoverAction]);
  return hook(handlers, config || {});
}

// src/lib/memo.ts
var firstMemo = (first, memo7, initializer) => {
  if (!first && !memo7) {
    throw new Error(
      "Missing memo initialization. You likely forgot to return the result of `firstMemo` in the event function"
    );
  }
  if (first) {
    return initializer();
  }
  return memo7;
};

// src/hooks/viewport/useViewportContainer.tsx
var WHEEL_ZOOM_SENSITIVITY = 0.01;
var WHEEL_INERTIA_GAP_MS = 140;
var WHEEL_INERTIA_ESCAPE_FACTOR = 1.35;
var useViewportContainer = ({
  containerRef,
  elementWrapperRef,
  elementRef
}) => {
  const originRef = useRef([0, 0]);
  const wheelInertia = useRef({
    active: false,
    lastTime: 0,
    lastAbsDeltaY: 0,
    lastSign: 0
  });
  const { maxZoom, minZoom } = usePdf((state) => state.zoomOptions);
  const zoom = usePdf((state) => state.zoom);
  const viewportRef = usePdf((state) => state.viewportRef);
  const setIsPinching = usePdf((state) => state.setIsPinching);
  const updateZoom = usePdf((state) => state.updateZoom);
  useEffect(() => {
    viewportRef.current = containerRef.current;
  }, [containerRef, viewportRef]);
  const transformations = useRef({
    translateX: 0,
    translateY: 0,
    zoom
  });
  const zoomRafRef = useRef(null);
  const lastPushedZoomRef = useRef(zoom);
  const updateTransform = useCallback(
    (zoomUpdate) => {
      if (!elementRef.current || !containerRef.current || !elementWrapperRef.current) {
        return;
      }
      const { zoom: zoom2, translateX, translateY } = transformations.current;
      const naturalWidth = parseFloat(elementRef.current.style.width) || elementRef.current.offsetWidth;
      const naturalHeight = parseFloat(elementRef.current.style.height) || elementRef.current.offsetHeight;
      elementRef.current.style.transform = `scale3d(${zoom2}, ${zoom2}, 1)`;
      elementWrapperRef.current.style.width = `${naturalWidth * zoom2}px`;
      elementWrapperRef.current.style.height = `${naturalHeight * zoom2}px`;
      containerRef.current.scrollTop = translateY;
      containerRef.current.scrollLeft = translateX;
      if (zoomUpdate && zoomRafRef.current === null) {
        zoomRafRef.current = requestAnimationFrame(() => {
          zoomRafRef.current = null;
          const z = transformations.current.zoom;
          lastPushedZoomRef.current = z;
          updateZoom(() => z);
        });
      }
    },
    [containerRef, elementRef, elementWrapperRef, updateZoom]
  );
  useEffect(() => {
    return () => {
      if (zoomRafRef.current !== null) {
        cancelAnimationFrame(zoomRafRef.current);
      }
    };
  }, []);
  useEffect(() => {
    if (transformations.current.zoom === zoom || !containerRef.current) {
      return;
    }
    if (zoom === lastPushedZoomRef.current) {
      return;
    }
    const prevZoom = transformations.current.zoom;
    if (!prevZoom || !Number.isFinite(prevZoom)) {
      transformations.current = {
        translateX: containerRef.current.scrollLeft,
        translateY: containerRef.current.scrollTop,
        zoom
      };
      updateTransform();
      return;
    }
    const dZoom = zoom / prevZoom;
    transformations.current = {
      translateX: containerRef.current.scrollLeft * dZoom,
      translateY: containerRef.current.scrollTop * dZoom,
      zoom
    };
    updateTransform();
  }, [containerRef, zoom, updateTransform]);
  useEffect(() => {
    const preventDefault = (e) => e.preventDefault();
    document.addEventListener("gesturestart", preventDefault);
    document.addEventListener("gesturechange", preventDefault);
    return () => {
      document.removeEventListener("gesturestart", preventDefault);
      document.removeEventListener("gesturechange", preventDefault);
    };
  }, []);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const sign = (n) => n === 0 ? 0 : n > 0 ? 1 : -1;
    const handleWheelCapture = (event) => {
      const st = wheelInertia.current;
      const now = Date.now();
      const ctrl = event.ctrlKey || event.metaKey;
      const abs = Math.abs(event.deltaY);
      const s = sign(event.deltaY);
      if (ctrl) {
        st.active = true;
        st.lastTime = now;
        st.lastAbsDeltaY = abs;
        st.lastSign = s;
        event.preventDefault();
        return;
      }
      if (!st.active) {
        return;
      }
      if (now - st.lastTime > WHEEL_INERTIA_GAP_MS) {
        st.active = false;
        return;
      }
      if (st.lastSign !== 0 && s !== 0 && s !== st.lastSign) {
        st.active = false;
        return;
      }
      if (st.lastAbsDeltaY > 0 && abs > st.lastAbsDeltaY * WHEEL_INERTIA_ESCAPE_FACTOR + 1) {
        st.active = false;
        return;
      }
      st.lastTime = now;
      st.lastAbsDeltaY = abs;
      st.lastSign = s;
      event.preventDefault();
    };
    container.addEventListener("wheel", handleWheelCapture, {
      passive: false,
      capture: true
    });
    return () => {
      container.removeEventListener("wheel", handleWheelCapture, {
        capture: true
      });
    };
  }, [containerRef]);
  useGesture(
    {
      onPinch: (state) => {
        const { origin, first, movement, delta, event, memo: memo7 } = state;
        const [ms] = movement;
        const [deltaScale] = delta;
        const currentElement = elementRef.current;
        const currentContainer = containerRef.current;
        if (!currentElement || !currentContainer) return;
        const newMemo = firstMemo(first, memo7, () => {
          const elementRect = currentElement.getBoundingClientRect();
          const containerRect = currentContainer.getBoundingClientRect();
          const currentZoom = transformations.current.zoom;
          const contentPosition = [
            origin[0] - elementRect.left,
            origin[1] - elementRect.top
          ];
          const containerPosition = [
            origin[0] - containerRect.left,
            origin[1] - containerRect.top
          ];
          originRef.current = [
            contentPosition[0] / currentZoom,
            contentPosition[1] / currentZoom
          ];
          return {
            contentPosition,
            containerPosition,
            originZoom: currentZoom,
            lastZoom: currentZoom
          };
        });
        if (first) {
          return newMemo;
        }
        const gestureValuesValid = Number.isFinite(ms) && ms > 0;
        let effectiveScale = ms;
        if (!gestureValuesValid) {
          const wheelEvent = event;
          if (wheelEvent?.deltaY !== void 0) {
            const wheelDelta = -wheelEvent.deltaY * WHEEL_ZOOM_SENSITIVITY;
            effectiveScale = newMemo.lastZoom / newMemo.originZoom * (1 + wheelDelta);
          } else if (Number.isFinite(deltaScale) && deltaScale !== 0) {
            effectiveScale = newMemo.lastZoom / newMemo.originZoom * (1 + deltaScale);
          } else {
            return newMemo;
          }
        }
        const newZoom = clamp(
          effectiveScale * newMemo.originZoom,
          minZoom,
          maxZoom
        );
        const realMs = newZoom / newMemo.originZoom;
        const newTranslateX = newMemo.contentPosition[0] * realMs - newMemo.containerPosition[0];
        const newTranslateY = newMemo.contentPosition[1] * realMs - newMemo.containerPosition[1];
        transformations.current = {
          zoom: newZoom,
          translateX: newTranslateX,
          translateY: newTranslateY
        };
        newMemo.lastZoom = newZoom;
        updateTransform(true);
        return newMemo;
      },
      onPinchStart: () => setIsPinching(true),
      onPinchEnd: () => setIsPinching(false)
    },
    {
      target: containerRef
    }
  );
  return {
    origin: originRef.current
  };
};
var selectLargestPageWidth = (state) => state.viewports.reduce((max, vp) => Math.max(max, vp.width), 0);
var DEFAULT_HEIGHT = 600;
var EXTRA_HEIGHT = 0;
var DEFAULT_VIRTUALIZER_OPTIONS = { overscan: 1 };
var VirtualizedPageItem = memo(
  ({ child, virtualItem, innerBoxWidth }) => {
    return /* @__PURE__ */ jsx(
      "div",
      {
        style: {
          width: innerBoxWidth,
          height: "0px"
        },
        children: /* @__PURE__ */ jsx(
          "div",
          {
            style: {
              height: `${virtualItem.size}px`,
              transform: `translateY(${virtualItem.start}px)`
            },
            children: cloneElement(child, {
              key: virtualItem.key,
              //@ts-expect-error pageNumber is not a valid react key
              pageNumber: virtualItem.index + 1
            })
          }
        )
      }
    );
  },
  (prev, next) => prev.child === next.child && prev.innerBoxWidth === next.innerBoxWidth && prev.virtualItem.key === next.virtualItem.key && prev.virtualItem.index === next.virtualItem.index && prev.virtualItem.size === next.virtualItem.size && prev.virtualItem.start === next.virtualItem.start
);
VirtualizedPageItem.displayName = "VirtualizedPageItem";
var Pages = ({
  children,
  gap = 10,
  virtualizerOptions = DEFAULT_VIRTUALIZER_OPTIONS,
  initialOffset,
  onOffsetChange,
  ...props
}) => {
  const [tempItems, setTempItems] = useState([]);
  const viewports = usePdf((state) => state.viewports);
  const numPages = usePdf((state) => state.pdfDocumentProxy.numPages);
  const isPinching = usePdf((state) => state.isPinching);
  const elementWrapperRef = useRef(null);
  const elementRef = useRef(null);
  const containerRef = useRef(null);
  useViewportContainer({
    elementRef,
    elementWrapperRef,
    containerRef
  });
  const setVirtualizer = usePdf((state) => state.setVirtualizer);
  const { scrollToFn } = useScrollFn();
  const { observeElementOffset, controller: scrollController } = useObserveElement();
  const viewportsRef = useRef(viewports);
  viewportsRef.current = viewports;
  const estimateSize = useCallback(
    (index) => {
      const vp = viewportsRef.current;
      if (!vp || !vp[index]) return DEFAULT_HEIGHT;
      return vp[index].height + EXTRA_HEIGHT;
    },
    []
    // Stable — reads from ref
  );
  const virtualizer = useVirtualizer({
    count: numPages || 0,
    getScrollElement: () => containerRef.current,
    estimateSize,
    observeElementOffset,
    overscan: virtualizerOptions?.overscan ?? 0,
    scrollToFn,
    gap,
    initialOffset
  });
  useEffect(() => {
    if (!onOffsetChange) return;
    return scrollController.addOffsetListener(onOffsetChange);
  }, [onOffsetChange, scrollController]);
  useEffect(() => {
    setVirtualizer(virtualizer);
  }, [setVirtualizer, virtualizer]);
  useEffect(() => {
    let timeout;
    let rafId = null;
    const virtualized = virtualizer?.getVirtualItems();
    if (!isPinching) {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        virtualizer?.measure();
      });
      timeout = setTimeout(() => {
        setTempItems([]);
      }, 200);
    } else if (virtualized && virtualized?.length > 0) {
      setTempItems(virtualized);
    }
    return () => {
      clearTimeout(timeout);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isPinching, virtualizer?.measure, virtualizer?.getVirtualItems]);
  const virtualizerItems = virtualizer?.getVirtualItems() ?? [];
  const items = tempItems.length ? tempItems : virtualizerItems;
  useVisiblePage({
    items
  });
  useFitWidth({ viewportRef: containerRef });
  const largestPageWidth = usePdf(selectLargestPageWidth);
  useEffect(() => {
    virtualizer.getOffsetForAlignment = (toOffset, align, itemSize = 0) => {
      const size = virtualizer.getSize();
      const scrollOffset = virtualizer.getScrollOffset();
      if (align === "auto") {
        align = toOffset >= scrollOffset + size ? "end" : "start";
      }
      if (align === "center") {
        toOffset += (itemSize - size) / 2;
      } else if (align === "end") {
        toOffset -= size;
      }
      const scrollSizeProp = virtualizer.options.horizontal ? "scrollWidth" : "scrollHeight";
      virtualizer.scrollElement ? "document" in virtualizer.scrollElement ? (
        //@ts-expect-error this is a private stuff
        virtualizer.scrollElement.document.documentElement[scrollSizeProp]
      ) : virtualizer.scrollElement[scrollSizeProp] : 0;
      return Math.max(toOffset, 0);
    };
  }, [virtualizer]);
  return /* @__PURE__ */ jsx(
    Primitive.div,
    {
      ref: containerRef,
      ...props,
      style: {
        display: "flex",
        justifyContent: "center",
        height: "100%",
        position: "relative",
        overflow: "auto",
        ...props.style
      },
      children: /* @__PURE__ */ jsx(
        "div",
        {
          ref: elementWrapperRef,
          style: {
            width: "max-content"
          },
          children: /* @__PURE__ */ jsx(
            "div",
            {
              ref: elementRef,
              style: {
                height: `${virtualizer.getTotalSize()}px`,
                position: "absolute",
                display: "flex",
                alignItems: "center",
                flexDirection: "column",
                transformOrigin: "0 0",
                // Only ask the compositor to keep this (huge) element on its
                // own layer while the user is actively pinching. Outside of
                // pinch, per-page `translateZ(0)` gives us per-page layers
                // which are cheaper to composite on scroll.
                willChange: isPinching ? "transform" : "auto",
                // width: "max-content",
                width: largestPageWidth,
                margin: "0 auto"
              },
              children: items.map((virtualItem) => {
                const innerBoxWidth = viewports?.[virtualItem.index] ? viewports[virtualItem.index]?.width : 0;
                if (!innerBoxWidth) return null;
                return /* @__PURE__ */ jsx(
                  VirtualizedPageItem,
                  {
                    child: children,
                    virtualItem,
                    innerBoxWidth
                  },
                  virtualItem.key
                );
              })
            }
          )
        }
      )
    }
  );
};

// src/lib/pdfjs.ts
var pdfJsPromise = null;
var loadPdfJs = () => {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfJsPromise;
};

// src/hooks/document/document.ts
function buildDocumentInitParams(source, overrides) {
  let params;
  if (typeof source === "string" || source instanceof URL) {
    params = { url: source };
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    params = { data: source };
  } else {
    params = { ...source };
  }
  const defaults = {
    // Skip the slow _guessMax binary-search auto-detection of max canvas area.
    // 1 GiB = 256 megapixels at 4 bytes/pixel. If the device can't allocate
    // this, pdfjs falls back gracefully via try/catch.
    canvasMaxAreaInBytes: 1024 * 1024 * 1024,
    // Enable GPU-backed canvases (willReadFrequently: false). PDF viewers are
    // render-dominated — they don't call getImageData() — so GPU compositing
    // is the correct path. This is the browser's default when no hint is given.
    enableHWA: true,
    // Explicitly opt-in to OffscreenCanvas in the worker for image processing.
    // Already the browser default, but being explicit avoids edge cases.
    isOffscreenCanvasSupported: true
  };
  return { ...defaults, ...params, ...overrides };
}
var usePDFDocumentContext = ({
  onDocumentLoad,
  source,
  initialRotation = 0,
  isZoomFitWidth,
  zoom = 1,
  zoomOptions,
  documentOptions
}) => {
  const [_, setProgress] = useState(0);
  const [initialState, setInitialState] = useState();
  const [rotation] = useState(initialRotation);
  const documentOptionsRef = useRef(documentOptions);
  documentOptionsRef.current = documentOptions;
  useEffect(() => {
    const generateViewports = async (pdf) => {
      const pageProxies = [];
      const rotations = [];
      const viewports = await Promise.all(
        Array.from({ length: pdf.numPages }, async (_2, index) => {
          const page = await pdf.getPage(index + 1);
          const deltaRotate = page.rotate || 0;
          const viewport = page.getViewport({
            scale: 1,
            rotation: rotation + deltaRotate
          });
          pageProxies.push(page);
          rotations.push(page.rotate);
          return viewport;
        })
      );
      const sortedPageProxies = pageProxies.toSorted(
        (a, b) => a.pageNumber - b.pageNumber
      );
      setInitialState((prev) => ({
        ...prev,
        isZoomFitWidth,
        viewports,
        pageProxies: sortedPageProxies,
        pdfDocumentProxy: pdf,
        zoom,
        zoomOptions
      }));
    };
    const loadDocument = () => {
      setInitialState(null);
      setProgress(0);
      let loadingTask = null;
      let isDisposed = false;
      void loadPdfJs().then(({ getDocument }) => {
        if (isDisposed) {
          return;
        }
        loadingTask = getDocument(
          buildDocumentInitParams(source, documentOptionsRef.current)
        );
        loadingTask.onProgress = (progressEvent) => {
          if (progressEvent.loaded === progressEvent.total) {
            return;
          }
          setProgress(progressEvent.loaded / progressEvent.total);
        };
        return loadingTask.promise.then((proxy) => {
          if (isDisposed || loadingTask?.destroyed) {
            return;
          }
          onDocumentLoad?.({ proxy, source });
          setProgress(1);
          return generateViewports(proxy);
        }).catch((error) => {
          if (isDisposed || loadingTask?.destroyed) {
            return;
          }
          console.error("Error loading PDF document", error);
        });
      }).catch((error) => {
        if (isDisposed) {
          return;
        }
        console.error("Error loading PDF.js", error);
      });
      return () => {
        isDisposed = true;
        void loadingTask?.destroy();
      };
    };
    return loadDocument();
  }, [source]);
  return {
    initialState
  };
};
var Root = forwardRef(
  ({
    children,
    source,
    loader,
    onDocumentLoad,
    isZoomFitWidth,
    zoom,
    zoomOptions,
    documentOptions,
    ...props
  }, ref) => {
    const { initialState } = usePDFDocumentContext({
      source,
      onDocumentLoad,
      isZoomFitWidth,
      zoom,
      zoomOptions,
      documentOptions
    });
    const linkService = useCreatePDFLinkService(
      initialState?.pdfDocumentProxy ?? null
    );
    const documentId = initialState?.pdfDocumentProxy?.fingerprints?.[0];
    useEffect(() => {
      if (!documentId) return;
      return () => {
        clearBitmapCache(documentId);
      };
    }, [documentId]);
    return /* @__PURE__ */ jsx(Primitive.div, { ref, ...props, children: initialState ? /* @__PURE__ */ jsx(PDFStore.Provider, { initialValue: initialState, children: /* @__PURE__ */ jsx(PDFLinkServiceContext.Provider, { value: linkService, children }) }) : loader ?? "Loading..." });
  }
);
Root.displayName = "Root";
var Search = ({ children, loading = "Loading..." }) => {
  const [isLoading, setIsLoading] = useState(false);
  const proxies = usePdf((state) => state.pageProxies);
  const setTextContent = usePdf((state) => state.setTextContent);
  const getTextContent = useCallback(
    async (pages) => {
      setIsLoading(true);
      const promises = pages.map(async (proxy) => {
        const content = await proxy.getTextContent();
        const text2 = content.items.map((item) => item?.str || "").join("");
        return Promise.resolve({
          pageNumber: proxy.pageNumber,
          text: text2
        });
      });
      const text = await Promise.all(promises);
      setIsLoading(false);
      setTextContent(text);
    },
    [setTextContent]
  );
  useEffect(() => {
    getTextContent(proxies);
  }, [proxies, getTextContent]);
  return isLoading ? loading : children;
};
var DEFAULT_CONFIG = {
  maxHeight: 800,
  maxWidth: 400
};
var useThumbnail = (pageNumber, config = {}) => {
  const {
    maxHeight = DEFAULT_CONFIG.maxHeight,
    maxWidth = DEFAULT_CONFIG.maxWidth,
    isFirstPage = false
  } = config;
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const pageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
  const { visible } = useVisibility({ elementRef: containerRef });
  const [debouncedVisible] = useDebounce(visible, 50);
  const dpr = useDpr();
  const isVisible = isFirstPage || debouncedVisible;
  useEffect(() => {
    const renderThumbnail = async () => {
      const canvas2 = canvasRef.current;
      if (!canvas2 || !pageProxy) return;
      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }
        const viewport = pageProxy.getViewport({ scale: 1 });
        const scale = Math.min(maxWidth / viewport.width, maxHeight / viewport.height) * (isVisible ? dpr : 0.5);
        const scaledViewport = pageProxy.getViewport({ scale });
        canvas2.width = scaledViewport.width;
        canvas2.height = scaledViewport.height;
        const context = canvas2.getContext("2d");
        if (!context) return;
        const renderTask = pageProxy.render({
          canvas: canvas2,
          canvasContext: context,
          viewport: scaledViewport
        });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
      } catch (error) {
        if (error instanceof Error && error.name === "RenderingCancelledException") {
          console.log("Rendering cancelled");
        } else {
          console.error("Failed to render PDF page:", error);
        }
      }
    };
    renderThumbnail();
    const canvas = canvasRef.current;
    return () => {
      renderTaskRef.current?.cancel();
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
    };
  }, [pageProxy, isVisible, dpr, maxHeight, maxWidth]);
  return {
    canvasRef,
    containerRef,
    isVisible
  };
};
var Thumbnail = ({
  pageNumber = 1,
  ...props
}) => {
  const { canvasRef, containerRef, isVisible } = useThumbnail(pageNumber, {
    isFirstPage: pageNumber < 5
  });
  const { jumpToPage } = usePdfJump();
  return /* @__PURE__ */ jsx("div", { ref: containerRef, style: { minHeight: "150px", minWidth: "10px" }, children: isVisible && /* @__PURE__ */ jsx(
    Primitive.canvas,
    {
      ...props,
      role: "button",
      tabIndex: 0,
      onClick: (e) => {
        if (props.onClick) {
          props.onClick(e);
        }
        jumpToPage(pageNumber, { behavior: "auto" });
      },
      onKeyDown: (e) => {
        if (props.onKeyDown) {
          props.onKeyDown(e);
        }
        if (e.key === "Enter") {
          jumpToPage(pageNumber, { behavior: "auto" });
        }
      },
      ref: canvasRef
    }
  ) });
};
var Thumbnails = ({
  children,
  ...props
}) => {
  const pageCount = usePdf((state) => state.pdfDocumentProxy.numPages);
  return /* @__PURE__ */ jsx(Primitive.div, { ...props, children: Array.from({
    length: pageCount
  }).map((_, index) => {
    return cloneElement(children, { key: index, pageNumber: index + 1 });
  }) });
};
var ZoomIn = ({ ...props }) => {
  const setZoom = usePdf((state) => state.updateZoom);
  return /* @__PURE__ */ jsx(
    Primitive.button,
    {
      ...props,
      onClick: (e) => {
        props.onClick?.(e);
        setZoom((zoom) => Number((zoom + 0.1).toFixed(1)));
      }
    }
  );
};
var ZoomOut = ({ ...props }) => {
  const setZoom = usePdf((state) => state.updateZoom);
  return /* @__PURE__ */ jsx(
    Primitive.button,
    {
      ...props,
      onClick: (e) => {
        props.onClick?.(e);
        setZoom((zoom) => Number((zoom - 0.1).toFixed(1)));
      }
    }
  );
};
var CurrentZoom = ({ ...props }) => {
  const updateZoom = usePdf((state) => state.updateZoom);
  const realZoom = usePdf((state) => state.zoom);
  const [zoom, setZoom] = useState((realZoom * 100).toFixed(0));
  const isInputFocused = useRef(false);
  useEffect(() => {
    if (isInputFocused.current) {
      return;
    }
    setZoom((realZoom * 100).toFixed(0));
  }, [realZoom]);
  return /* @__PURE__ */ jsx(
    "input",
    {
      ...props,
      value: zoom,
      onClick: () => {
        isInputFocused.current = true;
      },
      onChange: (e) => {
        updateZoom(Number(e.target.value) / 100);
        setZoom(e.target.value);
      },
      onBlur: () => {
        isInputFocused.current = false;
        setZoom((realZoom * 100).toFixed(0));
      }
    }
  );
};
function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}
var useSearch = () => {
  const textContent = usePdf((state) => state.textContent);
  const [keywords] = useState([]);
  const [searchResults, setSearchResults] = useState({
    exactMatches: [],
    fuzzyMatches: [],
    hasMoreResults: false
  });
  const findExactMatches = useCallback(
    (searchText, text, pageNumber, textSize) => {
      const results = [];
      const textLower = text.toLowerCase();
      const searchLower = searchText.toLowerCase();
      let index = 0;
      while (true) {
        const matchIndex = textLower.indexOf(searchLower, index);
        if (matchIndex === -1) break;
        results.push({
          pageNumber,
          text: text.substr(matchIndex, searchText.length + textSize),
          score: 1,
          matchIndex,
          isExactMatch: true,
          searchText
        });
        index = matchIndex + searchText.length;
      }
      return results;
    },
    []
  );
  const findFuzzyMatches = useCallback(
    (searchText, text, pageNumber, threshold, excludeIndices, textSize) => {
      const results = [];
      const textLower = text.toLowerCase();
      const searchLower = searchText.toLowerCase();
      let index = 0;
      while (index < textLower.length) {
        if (excludeIndices.has(index)) {
          index++;
          continue;
        }
        const chunk = textLower.substr(index, searchLower.length + 10);
        const distance = levenshteinDistance(
          searchLower,
          chunk.substr(0, searchLower.length)
        );
        const maxDistance = Math.floor(searchLower.length * (1 - threshold));
        if (distance <= maxDistance && distance > 0) {
          const score = 1 - distance / searchLower.length;
          results.push({
            pageNumber,
            text: text.substr(index, searchLower.length + textSize),
            score,
            matchIndex: index,
            isExactMatch: false,
            searchText
          });
          index += searchLower.length;
        } else {
          index++;
        }
      }
      return results;
    },
    []
  );
  const search = useCallback(
    (searchText, options = {}) => {
      const { threshold = 0.7, limit = 10, textSize = 100 } = options;
      if (!searchText.trim()) {
        const emptyResults = {
          exactMatches: [],
          fuzzyMatches: [],
          hasMoreResults: false
        };
        setSearchResults(emptyResults);
        return emptyResults;
      }
      let exactMatches = [];
      let fuzzyMatches = [];
      const exactMatchIndices = /* @__PURE__ */ new Set();
      textContent.forEach(({ pageNumber, text }) => {
        const matches = findExactMatches(
          searchText,
          text,
          pageNumber,
          textSize
        );
        exactMatches = [...exactMatches, ...matches];
        matches.forEach((match) => {
          for (let i = 0; i < searchText.length; i++) {
            exactMatchIndices.add(match.matchIndex + i);
          }
        });
      });
      textContent.forEach(({ pageNumber, text }) => {
        const matches = findFuzzyMatches(
          searchText,
          text,
          pageNumber,
          threshold,
          exactMatchIndices,
          textSize
        );
        fuzzyMatches = [...fuzzyMatches, ...matches];
      });
      exactMatches.sort((a, b) => b.score - a.score);
      fuzzyMatches.sort((a, b) => b.score - a.score);
      const exactLimit = Math.min(exactMatches.length, Math.ceil(limit / 2));
      const fuzzyLimit = Math.min(fuzzyMatches.length, limit - exactLimit);
      const limitedResults = {
        exactMatches: exactMatches.slice(0, exactLimit),
        fuzzyMatches: fuzzyMatches.slice(0, fuzzyLimit),
        hasMoreResults: exactMatches.length + fuzzyMatches.length > limit
      };
      setSearchResults(limitedResults);
      return limitedResults;
    },
    [textContent, findExactMatches, findFuzzyMatches]
  );
  return {
    textContent,
    keywords,
    searchResults,
    search
  };
};

// src/hooks/search/useSearchPosition.tsx
async function calculateHighlightRects(pageProxy, textMatch) {
  const textContent = await pageProxy.getTextContent();
  const items = textContent.items;
  const matchLength = textMatch.searchText ? textMatch.searchText.length : textMatch.text.length;
  const matchRects = [];
  let currentIndex = 0;
  let remainingMatchLength = matchLength;
  let foundStart = false;
  const viewport = pageProxy.getViewport({ scale: 1 });
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const itemLength = item.str.length;
    if (!foundStart && currentIndex <= textMatch.matchIndex && textMatch.matchIndex < currentIndex + itemLength) {
      foundStart = true;
      const matchStartInItem = textMatch.matchIndex - currentIndex;
      const matchLengthInItem = Math.min(
        itemLength - matchStartInItem,
        remainingMatchLength
      );
      const transform = item.transform;
      const y = viewport.height - (transform[5] + item.height);
      const rect = {
        pageNumber: textMatch.pageNumber,
        left: transform[4] + matchStartInItem * (item.width / itemLength),
        top: y,
        width: matchLengthInItem * (item.width / itemLength),
        height: item.height
      };
      matchRects.push(rect);
      remainingMatchLength -= matchLengthInItem;
    } else if (foundStart && remainingMatchLength > 0) {
      const matchLengthInItem = Math.min(itemLength, remainingMatchLength);
      const transform = item.transform;
      const y = viewport.height - (transform[5] + item.height);
      const rect = {
        pageNumber: textMatch.pageNumber,
        left: transform[4],
        top: y,
        width: matchLengthInItem * (item.width / itemLength),
        height: item.height
      };
      matchRects.push(rect);
      remainingMatchLength -= matchLengthInItem;
    }
    if (remainingMatchLength <= 0 && foundStart) {
      break;
    }
    currentIndex += itemLength;
  }
  return mergeAdjacentRects(matchRects);
}
function mergeAdjacentRects(rects) {
  if (rects.length <= 1) return rects;
  const merged = [];
  let current = rects[0];
  if (!current) return rects;
  for (let i = 1; i < rects.length; i++) {
    const next = rects[i];
    if (!next) continue;
    if (Math.abs(current.top - next.top) < 2 && Math.abs(current.height - next.height) < 2) {
      current = {
        ...current,
        width: next.left + next.width - current.left
      };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

// src/hooks/usePageRendered.ts
var usePageRendered = (pageNumber) => usePdf((state) => !!state.renderedPages[pageNumber]);

export { AnnotationHighlightLayer, AnnotationLayer, AnnotationTooltip, CanvasLayer, ColoredHighlightLayer, CurrentPage, CurrentZoom, CustomLayer, HighlightLayer, LinkService, NextPage, Outline, OutlineChildItems, OutlineItem, PDFLinkServiceContext, Page, Pages, PreviousPage, Root, Search, SelectionTooltip, TextLayer, Thumbnail, Thumbnails, TotalPages, ZoomIn, ZoomOut, calculateHighlightRects, useAnnotations, useCreatePDFLinkService, usePDFLinkService, usePDFPageNumber, usePageRendered, usePdf, usePdfJump, usePdfStore, useSearch, useSelectionDimensions };
