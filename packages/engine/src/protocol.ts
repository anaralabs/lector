// Messages between the viewer core and the PDFium raster workers.
// Coordinates sent to workers are in PDF points with a top-left origin.

export interface PageSize {
	w: number;
	h: number;
}

export type ToRaster =
	| { t: "init"; bytes: ArrayBuffer; port: MessagePort; wasmUrl: string }
	| {
			t: "tile";
			id: number;
			page: number;
			/** device pixels per PDF point */
			scale: number;
			/** tile origin in device pixels, relative to the page's top-left at `scale` */
			x: number;
			y: number;
			w: number;
			h: number;
	  }
	| { t: "text"; id: number; page: number }
	| { t: "outline"; id: number; page: -1 };

export interface Link {
	/** l, t, r, b in page points (top-left origin) */
	rect: [number, number, number, number];
	url?: string;
	/** internal destination */
	dest?: { page: number; top?: number };
}

export interface OutlineItem {
	title: string;
	dest?: { page: number; top?: number };
	children: OutlineItem[];
}

export type FromRaster =
	| { t: "opened"; pages: PageSize[] }
	| { t: "error"; message: string }
	| { t: "tile"; id: number; buf: ArrayBuffer; w: number; h: number; ms: number }
	| {
			t: "text";
			id: number;
			page: number;
			/** UTF-32 code points, one per PDFium char (generated spaces/newlines included) */
			codes: Uint32Array;
			/** l, t, r, b per char in page points (top-left origin); zero-area for generated chars */
			boxes: Float32Array;
			links: Link[];
			/** l, t, r, b per raster image in page points (top-left origin) */
			images: Float32Array;
			/** images classified as scan paper (tone-mapped in dark mode, so not in `images`) */
			scans: number;
			ms: number;
	  }
	| { t: "outline"; id: number; items: OutlineItem[] };
