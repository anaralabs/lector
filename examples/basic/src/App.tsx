import { CanvasLayer, Page, Pages, Root, TextLayer } from "@anaralabs/lector";
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { useState } from "react";
import "pdfjs-dist/web/pdf_viewer.css";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url
).toString();

export default function App() {
  const [dark, setDark] = useState(false);

  return (
    <div
      className={`min-h-screen p-8 ${dark ? "bg-neutral-900" : "bg-gray-100"}`}
    >
      <div className="mx-auto max-w-3xl">
        <div
          className={`mb-4 flex items-center justify-between rounded-lg p-4 shadow-sm ${
            dark ? "bg-neutral-800 text-neutral-100" : "bg-white"
          }`}
        >
          <h1 className="text-xl font-semibold">Lector PDF Viewer</h1>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setDark((d) => !d)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                dark
                  ? "bg-neutral-700 text-neutral-100 hover:bg-neutral-600"
                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
            >
              {dark ? "☀️ Light" : "🌙 Dark"}
            </button>
            <a
              href="https://github.com/anaralabs/lector"
              target="_blank"
              rel="noopener noreferrer"
              className={`text-sm ${
                dark
                  ? "text-neutral-400 hover:text-neutral-200"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              View on GitHub →
            </a>
          </div>
        </div>
        <div
          className={`rounded-lg shadow-sm ${dark ? "bg-neutral-800" : "bg-white"}`}
        >
          <Root
            source="/sample.pdf"
            className="h-[700px] w-full border overflow-hidden rounded-lg"
            loader={<div className="p-4">Loading...</div>}
            colorScheme={dark ? "dark" : "light"}
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
