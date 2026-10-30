# Third-party notices

`@anaralabs/lector-engine` is MIT-licensed (see `LICENSE`). Its published files
also contain third-party software:

- `dist/pdfium.wasm` is a WebAssembly build of [PDFium](https://pdfium.googlesource.com/pdfium/),
  taken unmodified from [`@embedpdf/pdfium`](https://www.npmjs.com/package/@embedpdf/pdfium) 2.15.1.
- `dist/raster-worker.js` bundles the JavaScript glue of `@embedpdf/pdfium`
  (Emscripten-generated runtime and bindings).

The full license texts ship next to the wasm:

| component | license | file |
| --- | --- | --- |
| PDFium | BSD-3-Clause and Apache-2.0 | `dist/LICENSE.pdfium` (copied from `@embedpdf/pdfium`) |
| `@embedpdf/pdfium` (glue, build) | MIT, Copyright (c) 2024 CloudPDF, Ji Chang | `dist/LICENSE.embedpdf` |

## Libraries compiled into PDFium

A PDFium build links these libraries from PDFium's `third_party/` directory.
Their licenses permit binary redistribution with attribution:

| library | license | upstream |
| --- | --- | --- |
| FreeType | FreeType License (FTL) | https://freetype.org/license.html |
| libjpeg-turbo | IJG, BSD-3-Clause, zlib | https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/LICENSE.md |
| OpenJPEG | BSD-2-Clause | https://github.com/uclouvain/openjpeg/blob/master/LICENSE |
| Little CMS | MIT | https://github.com/mm2/Little-CMS/blob/master/LICENSE |
| libpng | libpng License (PNG Reference Library License v2) | http://www.libpng.org/pub/png/src/libpng-LICENSE.txt |
| zlib | zlib License | https://zlib.net/zlib_license.html |
| Anti-Grain Geometry 2.3 | AGG license (BSD-style) | https://pdfium.googlesource.com/pdfium/+/main/third_party/agg23/ |
| Foxit fonts and code contributed to PDFium | PDFium license (above) | https://pdfium.googlesource.com/pdfium/+/main/LICENSE |
| Emscripten runtime | MIT | https://github.com/emscripten-core/emscripten/blob/main/LICENSE |

Required attributions:

- Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.
- This software is based in part on the work of the Independent JPEG Group.
