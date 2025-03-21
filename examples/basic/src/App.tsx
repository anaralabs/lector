import { CanvasLayer, Page, Pages, Root, TextLayer } from "@anaralabs/lector";
import { GlobalWorkerOptions } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";

// Configure PDF.js worker
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

export default function App() {
  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between rounded-lg bg-white p-4 shadow-sm">
          <h1 className="text-xl font-semibold">Lector PDF Viewer</h1>
          <a
            href="https://github.com/anaralabs/lector"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            View on GitHub →
          </a>
        </div>
        <div className="rounded-lg bg-white shadow-sm">
          <Root
            source="/sample.pdf"
            className="h-[700px] w-full border overflow-hidden rounded-lg"
            loader={<div className="p-4">Loading...</div>}
          >
            <Pages>
              <Page>
                <CanvasLayer />
                <TextLayer />
              </Page>
            </Pages>
          </Root>
        </div>
      </div>
    </div>
  );
}
