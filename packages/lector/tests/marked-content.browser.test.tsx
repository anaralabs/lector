import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { loadPdfJs } from "../src/lib/pdfjs";
import { createArtifactPdf } from "./fixtures/pdf";

afterEach(cleanup);

function spanWithText(container: HTMLElement, text: string) {
	return Array.from(
		container.querySelectorAll<HTMLElement>(
			".textLayer span:not(.markedContent)",
		),
	).find((span) => span.textContent === text);
}

test("hides Artifact text from assistive technology and keeps content text", async () => {
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	const view = render(
		<Root source={createArtifactPdf()} style={{ height: 700, width: 800 }}>
			<Pages>
				<Page>
					<TextLayer />
				</Page>
			</Pages>
		</Root>,
	);

	await waitFor(
		() => expect(spanWithText(view.container, "Body text")).toBeDefined(),
		{ timeout: 15000 },
	);
	const header = spanWithText(view.container, "Running header");
	const body = spanWithText(view.container, "Body text")!;

	expect(header?.closest(".markedContent")?.getAttribute("aria-hidden")).toBe(
		"true",
	);
	expect(body.closest(".markedContent")).not.toBeNull();
	expect(body.closest("[aria-hidden='true']")).toBeNull();
}, 20000);
