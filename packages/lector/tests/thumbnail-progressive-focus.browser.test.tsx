import {
	act,
	cleanup,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Root } from "../src/components/root";
import { Thumbnail, Thumbnails } from "../src/components/thumbnails";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createTextPdf } from "./fixtures/pdf";

afterEach(cleanup);

test("keyboard focus reaches a virtual thumbnail after its progressive page finishes loading", async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let store!: ReturnType<typeof PDFStore.useContext>;
	function Probe() {
		store = PDFStore.useContext();
		return null;
	}
	const view = render(
		<Root
			source={createTextPdf(12, 1)}
			progressive
			onDocumentLoad={({ proxy }) => {
				const getPage = proxy.getPage.bind(proxy);
				proxy.getPage = async (number) => {
					if (number === 12) await gate;
					return getPage(number);
				};
			}}
		>
			<Probe />
			<Thumbnails
				style={{ height: 450, width: 140 }}
				virtualize={{ itemHeight: 150, overscan: 2 }}
			>
				<Thumbnail style={{ height: 130, width: 100 }} />
			</Thumbnails>
		</Root>,
	);
	try {
		await waitFor(() => {
			expect(store).toBeTruthy();
			expect(
				Array.from({ length: 11 }, (_, i) =>
					store.getState().isPageLoaded(i + 1),
				).every(Boolean),
			).toBe(true);
		});
		const first = view.getByRole("button", { name: "Page 1" });
		first.focus();
		fireEvent.keyDown(first, { key: "End" });
		await waitFor(() =>
			expect(view.getByLabelText("Loading page 12")).toBeTruthy(),
		);
		// Let scroll/resize work settle while the destination row has no canvas.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
		});
		release();
		await waitFor(() =>
			expect(view.getByRole("button", { name: "Page 12" })).toBe(
				document.activeElement,
			),
		);
	} finally {
		release();
		view.unmount();
	}
}, 15000);
