# Third-party notices

Neattttty's own code is MIT (see LICENSE). The following third-party packages
are used under their own licenses. "Powered by" the Excalidraw open-source
editor; not affiliated with Excalidraw / Excalidraw+.

## github.com/excalidraw/excalidraw (`@excalidraw/excalidraw` 0.18.1) — MIT

```text
Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Other runtime dependencies

- `react`, `react-dom` — MIT
- `pptxgenjs` — MIT
- `lucide-react` (icons) — ISC
- `@fontsource/inter`, `@fontsource/ibm-plex-mono`, `@fontsource/caveat`
  (bundled UI fonts; font data under the SIL Open Font License 1.1)
- `@tauri-apps/api` — MIT OR Apache-2.0
- Build tooling (`vite`, `@vitejs/plugin-react`, `typescript`,
  `@tauri-apps/cli`, Tauri Rust crates) — MIT OR Apache-2.0

The app icon letterform is rendered in Caveat (SIL OFL 1.1); only our own
rasterized artwork ships, not the font file.

Run `npm ls` / `cargo tree` for the full dependency list.
No Excalidraw+ proprietary code, templates, styles, or assets are included.

## Ported algorithms (MIT, same license as above)

- `src/lib/shapeTools.ts` recognition math (resampling, PCA moments,
  hull-fill / corner-turn / kurtosis prototypes, arrow endpoint) is adapted
  from `packages/element/src/convertToShape.ts` in
  github.com/excalidraw/excalidraw (draw-to-shape, PR #9313).
- Bucket-fill tolerances (6px gap bridging, tiny min-area) follow
  `packages/element/src/bucketFill.ts` in the same repository (#11799);
  the raster/flood/trace pipeline itself is original.
