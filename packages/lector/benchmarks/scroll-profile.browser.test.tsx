import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { CanvasLayer } from "../src/components/layers/canvas-layer";
import { TextLayer } from "../src/components/layers/text-layer";
import { Page } from "../src/components/page";
import { Pages } from "../src/components/pages";
import { Root } from "../src/components/root";
import { PDFStore } from "../src/internal";
import { loadPdfJs } from "../src/lib/pdfjs";

afterEach(cleanup);
test("profiles fast-scroll CPU work", async () => {
	const protocol = cdp();
	await protocol.send("Emulation.setCPUThrottlingRate", { rate: 4 });
	const pdfjs = await loadPdfJs();
	pdfjs.GlobalWorkerOptions.workerSrc = new URL(
		"../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		import.meta.url,
	).href;
	try {
		for (const name of ["large", "expensive"]) {
			let store: ReturnType<typeof PDFStore.useContext> | undefined;
			function Probe() {
				store = PDFStore.useContext();
				return null;
			}
			const view = render(
				<Root
					source={
						new URL(`../../docs/public/pdf/${name}.pdf`, import.meta.url).href
					}
					colorScheme={name === "expensive" ? "dark" : "light"}
					style={{ height: 650, width: 370 }}
				>
					<Probe />
					<Pages>
						<Page>
							<CanvasLayer />
							<TextLayer />
						</Page>
					</Pages>
				</Root>,
			);
			await waitFor(
				() => expect(store?.getState().renderedPages[1]).toBe(true),
				{
					timeout: 30000,
				},
			);
			await protocol.send("Profiler.enable");
			await protocol.send("Profiler.start");
			const viewport = store!.getState().viewportRef.current!;
			const frames: number[] = [];
			let last = performance.now();
			for (let frame = 0; frame < 120; frame++)
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => {
						const now = performance.now();
						frames.push(now - last);
						last = now;
						const phase = frame % 60;
						const fraction = phase < 30 ? phase / 29 : (59 - phase) / 29;
						viewport.scrollTop =
							fraction *
							Math.max(0, viewport.scrollHeight - viewport.clientHeight);
						if (frame % 6 === 0)
							store!
								.getState()
								.updateZoom(
									[0.6, 1, 1.8, 3, 1.8, 1][Math.floor(frame / 6) % 6]!,
								);
						resolve();
					}),
				);
			const { profile } = await protocol.send("Profiler.stop");
			const totals = new Map<number, number>();
			profile.samples?.forEach((id: number, i: number) => {
				totals.set(id, (totals.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0));
			});
			const rows = profile.nodes
				.map((node) => ({
					name: node.callFrame.functionName,
					url: node.callFrame.url,
					line: node.callFrame.lineNumber,
					selfMs: (totals.get(node.id) ?? 0) / 1000,
				}))
				.sort((a, b) => b.selfMs - a.selfMs)
				.slice(0, 30);
			frames.sort((a, b) => a - b);
			const selfTime = (name: string) =>
				profile.nodes
					.filter((node) => node.callFrame.functionName === name)
					.reduce((sum, node) => sum + (totals.get(node.id) ?? 0) / 1000, 0);
			console.log(
				"SCROLL_PROFILE",
				JSON.stringify({
					name,
					drawImageMs: selfTime("drawImage"),
					fillTextMs: selfTime("fillText"),
					p95: frames[114],
					framesOver32: frames.filter((t) => t > 32).length,
					rows,
				}),
			);
			view.unmount();
		}
	} finally {
		await protocol.send("Profiler.stop").catch(() => {});
		await protocol.send("Emulation.setCPUThrottlingRate", { rate: 1 });
	}
}, 120000);
