import { render } from "@testing-library/react";
import { GlobalWorkerOptions } from "pdfjs-dist";
import PDFWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url&inline";
import React from "react";
import { test } from "vitest";

import { Root } from "../../dist";
GlobalWorkerOptions.workerSrc = PDFWorker;

test("renders name", () => {
  render(<Root fileURL="/form.pdf" />);
});
