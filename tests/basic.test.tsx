import { test } from "vitest";
import { render } from "@testing-library/react";
import { Root } from "../dist/pdfreader";
import React from "react";

test("renders name", () => {
  render(<Root fileURL="/form.pdf" />);
});
