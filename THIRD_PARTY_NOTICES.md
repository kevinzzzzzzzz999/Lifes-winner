# Third-party notices

The root MIT License applies to original InkSpace code. It does not replace the licenses of third-party code, fonts, images, tools or frameworks.

- JavaScript dependencies and their versions are declared in `desktop/package.json` and `desktop/package-lock.json`. Retain the notices shipped with installed dependencies when distributing a compiled application. Desktop packaging includes license collection tools.
- Bundled SheetJS source retains its Apache-2.0 license and provenance next to the source in `desktop/src/vendor/excel/` and `ios/InkSpace/Resources/Excel/`.
- Native math and Markdown resources retain their licenses and notices under `ios/InkSpace/Resources/Math/` and `ios/InkSpace/Resources/Markdown/`.
- PDF.js fonts, character maps and WebAssembly files are generated from the pinned npm dependency when building the desktop app. Preserve the included PDF.js and font notices in a binary distribution.
- Platform frameworks, Electron and optional runtimes are governed by their own terms. Optional runtime binaries and personal signing materials are not included in this source release.

See the component directories for bundled notices. Desktop packaging writes additional notices to its generated `LICENSES/` directory. Before distributing a binary, run license collection and artifact verification using the tools described in the desktop build guide.
