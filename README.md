<p align="center">
  <p align="center">
    <i>Simple primitives to compose powerful PDF viewing experiences.<br>powered by <code><a href="https://mozilla.github.io/pdf.js/">PDF.js</a></code> and <code><a href="https://reactjs.org/">React</a></code></i>
  </p>
</p>

# `lector`

A composable, headless PDF viewer toolkit for React applications, powered by `PDF.js`. Build feature-rich PDF viewing experiences with full control over the UI and functionality.

[![npm version](https://badge.fury.io/js/@anaralabs%2Flector.svg)](https://www.npmjs.com/package/@anaralabs/lector)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Installation

```bash
npm install @anaralabs/lector pdfjs-dist

# or with yarn
yarn add @anaralabs/lector pdfjs-dist

# or with pnpm
pnpm add @anaralabs/lector pdfjs-dist
```

## Basic Usage

Here's a simple example of how to create a basic PDF viewer:

```tsx
import { CanvasLayer, Page, Pages, Root, TextLayer } from "@anaralabs/lector";
import "pdfjs-dist/web/pdf_viewer.css";

export default function PDFViewer() {
  return (
    <Root
      source="/sample.pdf"
      className="w-full h-[500px] border overflow-hidden rounded-lg"
      loader={<div className="p-4">Loading...</div>}
    >
      <Pages className="p-4">
        <Page>
          <CanvasLayer />
          <TextLayer />
        </Page>
      </Pages>
    </Root>
  );
}
```

## Local Development using PNPM and Yalc

When you are using "pnpm link", you are bound to use pnpm on your consumer project when you are developing locally.
With yalc, we are decoupling the need for pnpm and now the package can be tested with any package managers. Any
changes should be automatically published to yalc on save, forcing a rebuilt and updating the consumer project.

Install yalc globally:

```
pnpm i yalc -g
```

From lector:

```bash
# navigate to lector package folder and install dependencies
pnpm i
# when you first start development, make sure you publish the package locally
yalc publish
# and run the project in development mode to start a watcher that rebuilds the project and pushes the changes locally on save
pnpm dev
```

From consumer project:
(It doesn't really matter what package manager you are using)

```bash
# add local package to your package.json of the consumer project using yalc
yalc add @anaralabs/lector
# or if you don't want to add the yalc package in your package.json
yalc link @anaralabs/lector
```

## Features

- 📱 Responsive and mobile-friendly
- 🎨 Fully customizable UI components
- 🔍 Text selection and search functionality
- 📑 Page thumbnails and outline navigation
- 🌗 First-class dark mode support
- 🖱️ Pan and zoom controls
- 📝 Form filling support
- 🔗 Internal and external link handling

## Contributing

We welcome contributions! Key areas we're focusing on:

1. Performance optimizations
2. Accessibility improvements
3. Mobile/touch interactions
4. Documentation and examples

## Thanks

Special thanks to these open-source projects that provided inspiration:

- [react-pdf-headless](https://github.com/jkgenser/react-pdf-headless)
- [pdfreader](https://github.com/OnedocLabs/pdfreader)

## License

MIT © [Anara](https://anara.com)
