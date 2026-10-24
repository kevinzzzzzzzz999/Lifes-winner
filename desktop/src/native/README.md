# Native editable ink helper (Mac)

This helper uses macOS PencilKit directly. It reads one bounded JSON request from stdin and emits one JSON response; it does not read or write vault files, show a window, or contact a server. The JavaScript caller performs conflict checks, backups and atomic board publication separately.

Build with `python3 src/native/build-helper.py` using Xcode. The arm64 target is macOS 13.0. The tested host uses SDK 26.5; this is a minimum deployment target check, not an actual macOS 13 runtime test. Windows has no bundled PencilKit helper.

**Keep the complete `InkSpaceInkHelper.app` bundle.** Its Info.plist bundle identifier is needed by PencilKit replica preferences. A standalone executable without that bundle identity can trap inside Foundation preferences even though it links successfully.

## Bridge

`new NativeBoardInkBridge({runtimePath, timeoutMs: 30000})` exposes `info()`, `apply({board, operation})`, `cancel()` and `dispose()`. Production runtime path is `resources/runtime/native-ink/darwin-arm64/InkSpaceInkHelper.app/Contents/MacOS/InkSpaceInkHelper`. There is no external runtime fallback. Only one operation runs at a time; children are spawned with `shell: false`. A nonzero exit never counts as success, even if stdout claims success.

Operations use `kind`:

- `frameInk {rect:{x,y,width,height},title?}` captures complete global strokes whose render bounds are within the rectangle. Crossing strokes remain outside the node. The node retains serialized PencilKit ink, pressure, tilt and masks.
- `move {ids,dx,dy}` changes selected item positions. PDF pages carry only unambiguously contained global strokes. Crossing strokes, ambiguous source/destination page ownership, landing on stationary ink, or intersecting unselected ink groups are refused.
- `patchItems {items:[{id,x?,y?,width?,height?}]}` applies the same rules to movement and resizing. Ink group resizing changes its native local drawing; PDF resizing applies a real native affine transform.
- `unpackInk {ids}` restores selected groups into global PencilKit coordinates and removes their group items.
- `collapseCheck {ids}` refuses PDF page removal when any global or grouped ink intersects those pages. Caller separately checks edges and provenance.

The helper returns patches only: `drawing`, `webInk`, `itemUpdates`, `newItems`, `removedIDs`, `selectedIDs`, optional `checked` and `warning`. Do not replace the whole board with this response. The caller must preserve unknown root/item fields, remove dangling edges for removed groups, and invalidate stale preview/PDF annotation provenance when world ink changes. Original PDFs are not written by this helper.

`drawing` and `inkData` are base64-encoded native PKDrawing data. `webInk` is only a browser preview derived again from the resulting native ink. The writing-aid fill's three collinear equal-width control points identify its paint strip even after native serialization normalizes its ink type to pen. These masked strips retain their complete sampled path and an optional world-space `clipPath`, applied once with the stroke transform: `[0,x,y]` move, `[1,x,y]` line, `[2,cpx,cpy,x,y]` quadratic, `[3,c1x,c1y,c2x,c2y,x,y]` cubic, `[4]` close. Other legacy masked ink retains the existing range sampling. Canvas and SVG apply nonzero clipping. An empty `clipPath: []` hides the whole stroke; an absent field keeps the legacy preview behavior. Each mask is bounded to 10,000 commands, all masks to 100,000 commands, and finite coordinates with absolute value at most 8,000,000. An absent preview under an exceeded preview budget is explicit (`WEB_INK_PREVIEW_LIMIT`); it never substitutes a bitmap for native ink. Browser-only ink cannot be converted back into a native drawing.

## Limits and refusal

Input is at most 64 MiB, output at most 96 MiB, native drawing data at most 40 MiB, up to 20,000 items, 50,000 strokes and 1,000,000 control points in the combined drawing. World size must be 1,000,000 or 8,000,000 square. Invalid/corrupt native data refuses the whole operation. The near-zero frame padding case is refused rather than reproducing a potentially shifting origin clamp.

Fixed error codes include `INK_RUNTIME_UNAVAILABLE`, `INK_TRANSFORM_FAILED`, `INK_CROSSES_BOUNDARY`, `COLLAPSE_HAS_CONTENT`, `NO_INK_SELECTED`, `INVALID_REQUEST`, `INVALID_BOARD`, `TOO_LARGE`, `BUSY`, and `CANCELLED`. No raw native error paths or drawing contents are sent as diagnostics.

## Verification scope

Synthetic tests run the production Swift core using native macOS PencilKit and the actual spawned bridge. They cover frame/move/unpack serialization, group/page scaling, masked pressure/tilt ink, boundary/ownership refusal, cancellation, timeout and invalid child exit. They do not claim a real iPad round trip, iCloud sync, or PDF annotation write-back. The core follows the same item-local normalization and world translation as the iPad implementation.
