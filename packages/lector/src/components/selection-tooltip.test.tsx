import {
	act,
	cleanup,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SelectionTooltip } from "./selection-tooltip";

const { viewportRef } = vi.hoisted(() => ({
	viewportRef: { current: null as HTMLDivElement | null },
}));
vi.mock("../internal", () => ({
	usePdf: (selector: (state: { viewportRef: typeof viewportRef }) => unknown) =>
		selector({ viewportRef }),
}));
afterEach(() => {
	cleanup();
	document.getSelection()?.removeAllRanges();
	viewportRef.current?.remove();
	viewportRef.current = null;
});

it("keeps tooltip actions clickable when a pointer press triggers selectionchange", async () => {
	viewportRef.current = document.createElement("div");
	document.body.append(viewportRef.current);
	const onHighlight = vi.fn();
	const { getByText } = render(
		<>
			<p>Selected PDF text</p>
			<SelectionTooltip>
				<button type="button" onClick={onHighlight}>
					Highlight
				</button>
			</SelectionTooltip>
		</>,
		{ container: viewportRef.current },
	);
	const range = document.createRange();
	range.selectNodeContents(getByText("Selected PDF text"));
	act(() => {
		document.getSelection()?.addRange(range);
		fireEvent(document, new Event("selectionchange"));
	});
	await waitFor(() => expect(getByText("Highlight")).toBeTruthy());
	const button = getByText("Highlight");
	fireEvent.pointerDown(button, { button: 0 });
	fireEvent(document, new Event("selectionchange"));
	await act(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
	expect(button.isConnected).toBe(true);
	fireEvent.pointerUp(button, { button: 0 });
	fireEvent.click(button);
	expect(onHighlight).toHaveBeenCalledOnce();
});

it("restores keyboard selection after a drag loses window focus", async () => {
	viewportRef.current = document.createElement("div");
	document.body.append(viewportRef.current);
	const { getByText, queryByText } = render(
		<>
			<p>PDF text</p>
			<SelectionTooltip>Selection actions</SelectionTooltip>
		</>,
		{ container: viewportRef.current },
	);
	const text = getByText("PDF text");
	fireEvent.pointerDown(text, { button: 0 });
	const range = document.createRange();
	range.selectNodeContents(text);
	act(() => {
		document.getSelection()?.addRange(range);
		fireEvent(document, new Event("selectionchange"));
	});
	await act(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
	expect(queryByText("Selection actions")).toBeNull();
	fireEvent(window, new Event("blur"));
	fireEvent(window, new Event("focus"));
	fireEvent(document, new Event("selectionchange"));
	await waitFor(() => expect(getByText("Selection actions")).toBeTruthy());
});
