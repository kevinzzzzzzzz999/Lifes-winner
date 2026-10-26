# Runtime source and build metadata

`notebook/kernel.py` is the application's own Notebook kernel bridge from the published desktop build 142 package. It is preserved byte for byte. The lock file and provenance/file manifests record that package's bundled third-party runtime inputs; they do not include the runtime binaries or installed packages.

The Python, Electron, Notebook-package, Tectonic and TeX licenses remain in the application's `Contents/Resources/LICENSES` directory. The provenance metadata preserves upstream license attribution.

Building a complete application requires assembling these runtime components into `desktop/runtime/` as described by the build documentation. `runtime-src/` by itself is source and metadata, not a preassembled runtime. Keep `kernel.py` in the packaged location `runtime/notebook/kernel.py`.

Other application-owned macOS helper sources are in `src/native/` and `scripts/work-mail-helper/`. No third-party Python package source trees or private user data were copied into this folder.
