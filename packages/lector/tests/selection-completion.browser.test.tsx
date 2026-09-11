import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { PDFPageProxy } from "pdfjs-dist";
import { useSyncExternalStore } from "react";
import { afterEach, expect, test } from "vitest";
import { PDFSelectionController } from "../src/lib/pdf-selection";

afterEach(cleanup);

function delayedSelection() {
	let rejectLoad!: (reason: Error) => void;
	const load = new Promise<PDFPageProxy>((_, reject) => {
		rejectLoad = reject;
	});
	const controller = new PDFSelectionController({
		pageCount: 2,
		loadPage: () => load,
	});
	const container = document.createElement("div");
	document.body.append(container);
	const disconnect = controller.connect(container);
	const disposers: (() => void)[] = [];
	const mount = (page: number, text: string) => {
		const layer = document.createElement("div");
		layer.innerHTML = `<span>${text}</span>`;
		container.append(layer);
		disposers.push(controller.registerLayer(layer, page, 600, 800));
	};
	mount(1, "First");
	controller.setSelection(
		{ pageNumber: 1, offset: 0 },
		{ pageNumber: 2, offset: 6 },
	);
	return {
		controller,
		mountLast: () => mount(2, "Second"),
		rejectLoad,
		dispose() {
			disconnect();
			for (const dispose of disposers) dispose();
			container.remove();
			rejectLoad(new Error("Disposed"));
		},
	};
}

test("mounting the last selected page immediately enables reactive selection actions", () => {
	const fixture = delayedSelection();
	function Action() {
		const selection = useSyncExternalStore(
			fixture.controller.subscribe,
			fixture.controller.getSnapshot,
		);
		return <button disabled={selection?.status !== "ready"}>Highlight</button>;
	}
	try {
		const view = render(<Action />);
		const button = view.getByRole("button") as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		act(fixture.mountLast);
		expect(fixture.controller.getSelection()?.text).toBe("First\n\nSecond");
		expect(button.disabled).toBe(false);
		expect(fixture.controller.getSnapshot()?.status).toBe("ready");
	} finally {
		act(fixture.dispose);
	}
});

test("mounted completion resolves an existing async request and ignores a late load failure", async () => {
	const fixture = delayedSelection();
	try {
		let text: string | undefined;
		const request = fixture.controller.getSelectionAsync().then((result) => {
			text = result?.text;
		});
		void request.catch(() => {});
		fixture.mountLast();
		await waitFor(() => expect(text).toBe("First\n\nSecond"));
		await request;
		fixture.rejectLoad(new Error("Redundant load failed"));
		// Drain the redundant hydration's rejection handler.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.controller.getSnapshot()?.status).toBe("ready");
	} finally {
		fixture.dispose();
	}
});

test("clearing an async selection does not wait for a stalled page load", async () => {
	const fixture = delayedSelection();
	try {
		let error: unknown;
		const request = fixture.controller.getSelectionAsync().catch((reason) => {
			error = reason;
		});
		fixture.controller.clear();
		await waitFor(() => expect(error).toMatchObject({ name: "AbortError" }));
		await request;
	} finally {
		fixture.dispose();
	}
});
