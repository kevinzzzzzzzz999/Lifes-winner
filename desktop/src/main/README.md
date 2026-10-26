# Life's Winner / 人生赢家 desktop local services

The renderer uses only `window.desktop` from `src/shared/desktop-api.ts`. Every call returns `{ok,value}` or `{ok:false,error:{code,message}}`; Python output arrives through a removable subscription. All file paths are relative to the vault root, including native whiteboard `sourcePath`. A Markdown reference must first be resolved against that Markdown file's parent; escaping the vault is rejected.

## What is implemented

- A native folder chooser grants an opaque folder ID. One-level listings support parent navigation. Linked files/folders, external hard links, changed root identity, absolute paths, `..`, Windows alternate stream/drive syntax and unsupported file types are rejected. `.git`/`.obsidian` internals are omitted from listings.
- UTF-8 `.md`, `.markdown`, `.tex`, `.py`, `.js`, `.ts`, `.txt`, `.json` can be read, edited and created. Creation never overwrites a file. An `.inkspace.json` is always recognized first and cannot be saved through the generic text API. Its native drawing and document/image objects remain protected; a separate narrow API edits text/formula nodes and edges only. Schema 1 validation includes finite geometry, old 1M/new 8M canvases, and at most one million web-ink sample points.
- A text or permitted board-element save compares SHA-256, stores both the original and proposed contents in local application backups, writes and flushes a same-folder temporary file, checks the original again, and atomically replaces it. UTF-8 BOM and consistent CRLF/LF are retained. The backups use content hashes and contain a prepared before/after manifest, so both versions remain available even if saving is interrupted. Backups are in the app's local user-data directory, not duplicated into the vault. A 2 GiB content budget or failed/corrupt backup causes refusal before modifying the original; automatic backup pruning is not implemented.
- PDF/PNG/JPG/JPEG are served by opaque, version-bound `vault-asset://` URLs with single HTTP byte ranges; no general `file://` reader is exposed. Changing the source invalidates the previous URL. The source limit is 128 MiB, text 4 MiB, board 64 MiB, DOCX 16 MiB.
- DOCX is read offline with Mammoth after validating ZIP structure and actual decompression budgets (4,096 entries, 48 MiB total, 24 MiB per entry). Preview fidelity is limited. Images are PNG/JPEG with per-image/combined limits and visible warnings for omissions. **The renderer must sanitize the returned HTML.** On Mac, legacy binary `.doc` snapshots up to 16 MiB can be converted in memory by the system `textutil` reader, with a 10 second deadline and 16 MiB output limit, then pass through the same bounded DOCX preview. This is read-only and may differ from the original layout; encrypted, damaged and unsupported Word variants fail without modifying their sources. `.ppt` and complete Office layout editing are not provided by this service.
- Python runs only when the run API is requested for a saved `.py` with the current SHA. It executes a private snapshot with the original `__file__` and working directory. Only the bundled Python 3.14.7 path is used; there is no fallback to a host executable. `-B` prevents cache writes into the signed application and adjacent source folders. `-I -S -u` avoids startup/user-site environment injection; explicit imports from the script directory remain possible. JavaScript/TypeScript are editable text and are never executed by this API.
- Python is noninteractive (stdin is closed) and has one active job, 60-second time and 2 MiB combined output limits, stdout/stderr/exit reporting, and best-effort process-tree termination on cancel/window close. Unix uses the owned process group; Windows uses the system `taskkill.exe` for the owned child PID. **This is ordinary user-permission Python, not a security sandbox:** a script can read/write files and use the network within that user's OS permissions. Isolation flags and output/time limits do not prevent a malicious script from escaping process cleanup or consuming other resources. The UI requires an explicit first-run session confirmation.
- Diagnostics store bounded fixed operation/error codes, counts and dates, excluding raw errors, file paths and document contents. Export uses a native save dialog. External HTTP(S) links require a native confirmation showing the URL; credentials and other schemes are rejected. Current-view PDF export uses Electron `printToPDF`, not a full infinite-whiteboard export. The separately implemented ChatGPT panel uses an isolated remote browser session; it has no vault preload/IPC. Capture/paste are explicit user operations; chat content is not scraped and sending is manual. LaTeX supports source editing/math preview in the renderer, not a full TeX compiler.

## Knowledge base and mind maps

`searchNotes` scans `.md`, `.markdown`, `.txt`, `.tex`, `.py` without executing or modifying them. Each scan has at most 5,000 visited files, 32 MiB text, 1 MiB per file, 1,000 folders and a five-second deadline; at most two scans are active. A timed-out read-only OS operation may still finish and close its handle in the background. Results cap at 200 and carry `truncated`/warnings. Hidden directories, `node_modules`, backup directories, linked files and unsupported/binary files are omitted. No index is written into the vault and no PDF/OCR search is claimed. Tags include inline hashtags and simple YAML `tags` values/lists; this is not a general YAML interpreter.

`noteLinks` reads a current Markdown snapshot, extracts wiki and relative inline Markdown links outside common code spans/blocks, and provides outgoing labels/targets, backlinks and tags. Alias labels and original targets including headings are distinct. Duplicate basenames remain unresolved/ambiguous. A truncated index never claims a wiki basename is unique. External URLs and images are not note backlinks. Link syntax coverage is bounded; reference-style Markdown links, arbitrary HTML and complete Obsidian syntax compatibility are not claimed.

`knowledgeGraph` returns at most 1,000 Markdown nodes and 5,000 deduplicated directed edges from resolved wiki links. It never guesses an ambiguous destination or writes a graph index to the vault.

`createBoard` creates a schema-1 8M-world board with one text root, no fabricated native drawing bytes and a genuine optional absent `drawing`. The actual native `BoardDocument.decode` has also decoded a synthetic desktop-created/edited board. `saveBoardElements` accepts complete item/edge arrays: existing non-text/formula objects stay in the same relative order and cannot be removed. Their title, style and geometry can be edited; all other supplied fields must equal the original. Geometry changes pass through the local native ink helper before the same atomic commit. New items are text/formula only and cannot attach source paths, URLs or ink bytes. Existing unknown root/item/edge/style fields are retained; node geometry, styles, all edge endpoints and SHA are validated. Text-node movement does **not** move overlaid native pen strokes. The revision increments, the persistent desktop writer UUID is recorded, and timestamps use ISO seconds. Unsafe integer metadata is refused instead of being rounded on rewrite. Before/after local backups and the same guarded atomic replacement as text saving protect changes.

Node styles have three shapes, six-digit colors, font 8–72 and stroke 1–8; edge styles have color, stroke 1–12 and no/end/both arrows. The native application's separate Codable integration is responsible for retaining these style fields when it next saves the board.

`importImage` opens a native PNG/JPEG chooser only after the user requests it. It validates byte/pixel budgets, copies the chosen source into the selected authorized folder under an exclusive unique name, and returns a relative path/capability URL. It does not overwrite or alter the selected source, or create a second application-data copy of an image. Source bytes are retained exactly; full visual rendering is checked separately in GUI acceptance.

## Security and concurrency boundaries

The main window has sandbox/context isolation enabled, Node integration and webviews disabled, and permissions/popups/navigation denied. IPC is accepted only from the exact trusted top frame. The preload exposes individual capabilities, never `ipcRenderer`, arbitrary OS paths or a shell. App resources use a custom origin with CSP; unsolicited remote resource requests in the local document renderer are blocked. The optional isolated ChatGPT session can use HTTPS when the user opens it.

SHA checks detect changes before and during backup, and same-app writes serialize. Portable Node file APIs do not offer a cross-process compare-and-swap or iCloud coordination transaction: a different app could write in the narrow final-check/rename interval. Avoid editing one file concurrently in multiple apps. The checks defend static path/link escapes and revalidate identities; they do not claim an OS filesystem sandbox against a hostile same-user process racing directory operations.

## Development and verification

Run the actual synthetic Node tests from the desktop directory:

```sh
node --test test/backend*.test.cjs
```

The Python tests use the bundled platform runtime by default; an explicit `INKSPACE_TEST_PYTHON` can select a test interpreter. They do not silently skip unavailable runtimes. Mac arm64 tests actually execute Python 3.14.7; Windows behavior requires Windows execution and is not inferred from PE inspection.

Development-only environment settings are ignored by packaged builds:

- `INKSPACE_RENDERER_URL`: exact local HTTP loopback development origin.
- `INKSPACE_QA_USER_DATA`: isolates app preferences/backups before startup.
- `INKSPACE_QA_VAULT`: grants only that synthetic folder **after** the tester clicks the folder chooser; startup does not grant or execute anything.

Synthetic tests cover original-byte preservation, unknown board fields, backup-before-save failures, edits during backup, same-version concurrent writes, links/traversal, code creation, knowledge links/graph budgets, protected mind-map edits/styles, actual image copies, bounded media ranges, bad geometry/point budgets, private diagnostic details, DOCX parsing and bad ZIPs, actual Python Unicode/stderr/nonzero exit, no run on open, SHA refusal, cancellation, concurrency, timeout, output limit, metacharacter names and isolated startup. The evidence JSON binds the source files actually tested. Electron UI/packaged application acceptance is a separate parent-run check.

Official implementation references (reviewed September 2026): [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [custom protocol API](https://www.electronjs.org/docs/latest/api/protocol), [Node spawn](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options), [Node file open](https://nodejs.org/api/fs.html#fspromisesopenpath-flags-mode), [Node rename](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath), [Python isolated mode](https://docs.python.org/3/using/cmdline.html#cmdoption-I), [Mammoth security](https://github.com/mwilliamson/mammoth.js#security).


## Board management 0.8.5

`mutateBoard({vaultId,path,expectedSHA256,operation})` supports `move`, `patchItems`, `frameInk`, `unpackInk`, `expandDocument`, `collapseDocument`, and `connect`. The input never accepts new native drawing bytes. Existing root and item extension fields are retained. The original board SHA is checked before calculation and again immediately before the guarded atomic replacement, with both before/after data in the independent local backup first. No source PDF is rewritten by these operations.

Mac geometry operations on boards containing native ink use the bundled native PencilKit helper. Page-contained strokes move/scale with their page; a crossing stroke or ambiguous overlap stops the operation. Framing creates a real editable `inkGroup` from complete selected strokes. Unpacking refuses a node with edges, so no edge can silently become dangling. Missing runtimes refuse native-ink changes; plain metadata-only boards can still be organized. Windows does not gain a fabricated PencilKit decoder.

PDF expansion reads only metadata through pdf-lib, honors crop dimensions and quarter-turn rotation, and lays out at the requested origin (default: immediately below the source card). The default UI is vertical; horizontal/grid and scale 25–200% are supported. Up to 2000 pages are referenced without source copies or prerendered images. Whole-layout bounds are validated before publication. Re-expanding a source card reuses its page UUIDs. Each generated page has `sourceCardID`; the original source card remains. Collapse only deletes its generated cards, and refuses ink or edges that would otherwise be orphaned. The native schema remains 1; older native versions that do not preserve the optional `sourceCardID` can still read the pages/ink but lose the source-card collapse association when saving.

Changed native ink invalidates the cached board screenshot and PDF-export digest declarations. `getAssetUrl({...,hideBoardID})` creates a distinct read-only token. The in-memory PDF view removes only annotations owned by that board; other annotations and the original file are retained. SHA values still identify the original source. Filtered bytes use an eight-entry/64 MiB cache, with bounded simultaneous conversions, and ranged responses refer to the filtered bytes. This preview is not a claim that the original PDF has been saved with the new ink.

Targeted tests: `test/backend-board-operations.test.cjs`, `test/backend-native-management.test.cjs`, `test/backend-board-preview-assets.test.cjs`. The committed native fixture contains only synthetic strokes generated with macOS PencilKit. These tests do not read devices or user vaults.


## Display name and compatibility

The English product name is **Life's Winner** (ASCII apostrophe); Chinese is **人生赢家**. `app-brand.cjs` pins the existing `userData`, `sessionData` and logs paths before changing Electron's display name. The `inkspace` app/bundle IDs, storage keys, URI schemes, `.inkspace.json` files and embedded `application: 'InkSpace'` integrity envelopes remain compatibility identifiers, not alternate display names.
