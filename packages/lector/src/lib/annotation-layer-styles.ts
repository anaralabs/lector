const ANNOTATION_LAYER_STYLE_ID = "lector-annotation-layer-styles";

const annotationLayerStyles = `
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

export const ensureAnnotationLayerStyles = () => {
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
