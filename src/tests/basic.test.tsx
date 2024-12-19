import { test } from "vitest";
import { render } from "@testing-library/react";
import { Root } from "../../dist";
import React from "react";

import PDFWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url&inline";
import { GlobalWorkerOptions } from "pdfjs-dist";
GlobalWorkerOptions.workerSrc = PDFWorker;

test("renders name", () => {
  render(<Root fileURL="/form.pdf" />);
});
