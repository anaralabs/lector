const TEXT_LAYER_STYLE_ID = "lector-text-layer-styles";

const textLayerStyles = `
  .textLayer {
    position: absolute;
    inset: 0;
    text-align: initial;
    overflow: clip;
    opacity: 1;
    line-height: 1;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    caret-color: CanvasText;
    z-index: 2;
    contain: layout style;
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor, 1) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }

  .textLayer span,
  .textLayer br {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
  }

  .textLayer > :not(.markedContent),
  .textLayer .markedContent span:not(.markedContent) {
    z-index: 1;
    --font-height: 0px;
    --scale-x: 1;
    --rotate: 0deg;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }

  .textLayer .markedContent {
    display: contents;
  }

  .textLayer span[role="img"] {
    cursor: default;
    user-select: none;
  }

  .textLayer .endOfContent {
    display: block;
    position: absolute;
    left: 0;
    top: 100%;
    right: 0;
    bottom: 0;
    z-index: -1;
    cursor: default;
    user-select: none;
  }

  .textLayer.selecting .endOfContent {
    top: 0;
  }

  .textLayer span::selection,
  .textLayer br::selection,
  .textLayer .endOfContent::selection {
    background: rgba(0, 102, 255, 0.25);
  }
`;

export const ensureTextLayerStyles = () => {
	if (typeof document === "undefined") {
		return;
	}

	if (document.getElementById(TEXT_LAYER_STYLE_ID)) {
		return;
	}

	const style = document.createElement("style");
	style.id = TEXT_LAYER_STYLE_ID;
	style.textContent = textLayerStyles;
	document.head.appendChild(style);
};
