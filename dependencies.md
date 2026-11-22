# Dependencies

Every direct dependency and its licence. `npm run licences` checks everything that actually ships inside the app, dependencies of dependencies included, and fails on anything outside the approved list.

## Shipped in the app

| Package | Licence | What it's for |
|---|---|---|
| electron | MIT | The app shell. Includes Chromium, which carries some LGPL and MPL-2.0 parts (FFmpeg, WebKit-derived code, NSS, Hunspell), approved as "Chromium as Electron ships it, with its notices" (Orlando, 2026-11-17, widening his approval of 2026-11-08 of Chromium's LGPL and MPL parts). The app carries Electron's licence and Chromium's notices unchanged (`LICENSE` and `LICENSES.chromium.html` in `Contents/Resources`), and each download is checked for them. |
| prosemirror-model, -state, -view, -transform, -commands, -keymap, -history, -schema-list | MIT | The editor engine. |
| prosemirror-markdown | MIT | Converts between Markdown and the editor's document. |
| markdown-it | MIT | Reads Markdown. |
| markdown-it-footnote | MIT | Recognises footnotes. Its last step (`footnote_tail`) is replaced by Corillo's own (`footnoteTail` in `src/core/markdown-tokens.ts`), which follows its shape and builds the same tokens in one pass. |
| prosemirror-tables | MIT | Table editing: cell selection, adding and removing rows and columns. |
| prosemirror-inputrules, -dropcursor, -gapcursor | MIT | Markdown shortcuts as you type, drop position, cursor beside tables. |
| smol-toml | BSD-3-Clause | Reads Codex's TOML settings file, to check it before and after Corillo adds itself. No dependencies of its own. |
| mermaid | MIT | Draws diagrams. Built as its own file (`diagrams.js`), loaded only when a document has a diagram. Brings about 70 packages, all permissive (checked by `npm run licences`); dompurify is "MPL-2.0 OR Apache-2.0", used under Apache-2.0. Its optional ELK layout (elkjs, EPL-2.0 OR GPL-3.0) is left out of the build. |

## Fonts shipped in the app

| Font | Licence | What it's for |
|---|---|---|
| Literata (TypeTogether, from Google Fonts) | SIL Open Font License 1.1 (approved by Orlando 2026-11-09) | The page's font, made for long reading on screens. The two variable font files (regular and italic, every weight and optical size) are in `src/renderer/fonts/` with the licence (`Literata-OFL.txt`); the licence also goes into `dist/third-party-notices.txt`. No Reserved Font Name. The OFL lets the font be used, bundled and shared freely, including at work; it can't be sold on its own. Word files don't use it: they use Word's default font, or the template's. |

## Bundled as a separate program

| Program | Licence | What it's for |
|---|---|---|
| Pandoc 3.13 | GPL-2.0-or-later (approved by Orlando 2026-11-08) | Makes Word documents. `npm run fetch-pandoc` downloads the official macOS builds (checksums pinned) into `vendor/pandoc/<arch>/pandoc`, with its licence (`COPYING`) and copyright notice and source link (`COPYRIGHT`). The app runs it as a separate program and ships it as `pandoc/` in its resources. Corillo's Word style file is written from scratch, not derived from Pandoc's GPL default. |

## Packaging (not shipped)

`npm run package` adds no packages. It uses tools that come with macOS: `ditto` (copies the app), `plutil` (app settings), `iconutil` (icon file), `codesign` (ad-hoc signature) and `hdiutil` (disk image). The icon's sizes are drawn from the SVGs in `assets/` by Electron itself. `npm run build` also writes `dist/third-party-notices.txt`, the licence text of every shipped package, which ships inside the app.

The agent connector (`dist/mcp.cjs`) uses no packages: its part of the MCP protocol is written by hand from the published specification.

## Development only (not shipped)

| Package | Licence | What it's for |
|---|---|---|
| esbuild | MIT | Builds the app. |
| typescript | Apache-2.0 | Type checking. |
| vitest | MIT | Unit tests. |
| @playwright/test | Apache-2.0 | End-to-end tests that drive the real app. |
| @types/markdown-it, @types/markdown-it-footnote, @types/node | MIT | Type definitions. |

## Installed but not shipped

`npm ci` installs a few packages whose licences aren't on the approved list. None of them goes into the app, which `npm run licences` checks on every `npm test`.

| Package | Licence | Why it's there |
|---|---|---|
| lightningcss | MPL-2.0 | Brought by vite, under vitest, for the tests. |
| argparse | Python-2.0 | Brought by markdown-it, for its command line only. The app doesn't use it. |
| elkjs | EPL-2.0 OR GPL-3.0-or-later | Mermaid's optional ELK layout, left out of the build. |

One shipped package, khroma (brought by mermaid), has no licence in its `package.json`; its licence file is MIT, and `npm run licences` reads it there.
