import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
  cloneElement,
  type HTMLProps,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useFitWidth } from "../hooks/pages/useFitWidth";
import { useObserveElement } from "../hooks/pages/useObserveElement";
import { useScrollFn } from "../hooks/pages/useScrollFn";
import { useVisiblePage } from "../hooks/pages/useVisiblePage";
import { useViewportContainer } from "../hooks/viewport/useViewportContainer";
import { usePdf } from "../internal";
import { Primitive } from "./primitive";

const VIRTUAL_ITEM_GAP = 10;
const DEFAULT_HEIGHT = 600;
const EXTRA_HEIGHT = 0;

export const Pages = ({
  children,
  virtualizerOptions = { overscan: 3 },
  ...props
}: HTMLProps<HTMLDivElement> & {
  virtualizerOptions?: {
    overscan?: number;
  };
  children: ReactElement;
}) => {
  const [tempItems, setTempItems] = useState<VirtualItem[]>([]);

  const viewports = usePdf((state) => state.viewports);
  const numPages = usePdf((state) => state.pdfDocumentProxy.numPages);
  const isPinching = usePdf((state) => state.isPinching);

  const elementWrapperRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useViewportContainer({
    elementRef: elementRef,
    elementWrapperRef: elementWrapperRef,
    containerRef,
  });

  const setVirtualizer = usePdf((state) => state.setVirtualizer);

  const { scrollToFn } = useScrollFn();
  const { observeElementOffset } = useObserveElement();

  const estimateSize = useCallback(
    (index: number) => {
      if (!viewports || !viewports[index]) return DEFAULT_HEIGHT;
      return viewports[index].height + EXTRA_HEIGHT;
    },
    [viewports],
  );

  const virtualizer = useVirtualizer({
    count: numPages || 0,
    getScrollElement: () => containerRef.current,
    estimateSize,
    observeElementOffset,
    overscan: virtualizerOptions?.overscan ?? 0,
    scrollToFn,
    gap: VIRTUAL_ITEM_GAP,
  });

  useEffect(() => {
    setVirtualizer(virtualizer);
  }, [setVirtualizer, virtualizer]);

  useEffect(() => {
    let timeout: NodeJS.Timeout;
    const virtualized = virtualizer?.getVirtualItems();

    if (!isPinching) {
      virtualizer?.measure();

      timeout = setTimeout(() => {
        setTempItems([]);
      }, 200);
    } else if (virtualized && virtualized?.length > 0) {
      setTempItems(virtualized);
    }

    return () => {
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPinching]);

  const virtualizerItems = virtualizer?.getVirtualItems() ?? [];
  const items = tempItems.length ? tempItems : virtualizerItems;

  // const { normalizedVelocity } = useVirtualizerVelocity({
  //   virtualizer,
  // });

  // const isScrollingFast = Math.abs(normalizedVelocity) > 1.5;
  // const shouldRender = !isScrollingFast;

  useVisiblePage({
    items,
  });

  useFitWidth({ viewportRef: containerRef });
  const largestPageWidth = usePdf((state) =>
    Math.max(...state.viewports.map((v) => v.width)),
  );

  return (
    <Primitive.div
      ref={containerRef}
      {...props}
      style={{
        display: "flex",
        justifyContent: "center",
        height: "100%",
        position: "relative",
        overflow: "auto",
        ...props.style,
      }}
    >
      <div
        ref={elementWrapperRef}
        style={{
          width: "max-content",
        }}
      >
        <div
          ref={elementRef}
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "absolute",
            display: "flex",
            alignItems: "center",
            flexDirection: "column",
            transformOrigin: "0 0",
            // width: "max-content",
            width: largestPageWidth,
            margin: "0 auto",
          }}
        >
          {items.map((virtualItem) => {
            const innerBoxWidth =
              viewports && viewports[virtualItem.index]
                ? viewports[virtualItem.index]?.width
                : 0;

            if (!innerBoxWidth) return null;

            return (
              <div
                key={virtualItem.key}
                style={{
                  width: innerBoxWidth,
                  height: `0px`,
                }}
              >
                <div
                  style={{
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {cloneElement(children, {
                    key: virtualItem.key,
                    //@ts-expect-error pageNumber is not a valid react key
                    pageNumber: virtualItem.index + 1,
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Primitive.div>
  );
};
