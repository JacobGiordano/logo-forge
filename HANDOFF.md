Last updated: 2026-10-23

## Status

Issues #11-#40 complete and shipped. This ship adds drop-to-replace (no issue number): dragging an image file anywhere over the app replaces the loaded image instead of the browser opening it in a new tab. Suite: 51 passed, 1 known flake (see Gotchas).

## Decisions made this session

- Drop-to-replace: `#dropzone` is hidden after load, so its drop handlers stopped firing and the browser default took over. Moved file-drop handling to window-level dragenter/dragover/dragleave/drop (only for drags carrying `'Files'`), all routed through `handleFile` — single code path; `#dropzone` handlers now only toggle its highlight.
- In-page drags (e.g. the `<img>` thumbnail, which Chrome reports as `'Files'`) are ignored via a document-level `dragstart` flag.
- `#drop-overlay` ("Drop to replace image") shows only once an image is loaded; `pointer-events:none`, depth-counter to avoid flicker. Needs explicit `#drop-overlay[hidden]{display:none}` because its `display:flex` otherwise beats `[hidden]`.
- State on replace is identical to the replace-file input (by construction): clears remembered crop only; undo history, Levels, settings, and trace output persist — pre-existing behavior, left as-is.

## Next issues

- #33 (Scout): Playwright coverage for the #26/#28 tooltip/popover feature — still open.
- Scout: regression test for drop-to-replace (scratch harness used for manual verification, not in `tests/`).
- Possible: `handleFile` silently ignores dropped non-image files (file pickers' `accept="image/*"` used to hide this) — consider a user-facing message.
- Color-aware tracing: on hold per user request.
- Possible future: `touchcancel` handling for pinch/pan (flagged in #23, not urgent).

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `preprocessImageData` (`js/app.js`) is async, gated by `BILINEAR_NATIVE_SAFE_LIMIT=3500` and the #37 upload cap at 6000px — verify at real upload sizes
- `SMALL_SOURCE_DIM=256` gates #39's relaxed smoothMask/despeckle — tune both size tiers
- Levels (`applyLevels()`) runs before Otsu/threshold resolution on both native and bilinear paths
- `tests/bilinear.spec.ts:172` (3499px gate) is a known pre-existing sandbox timing flake — fails on unmodified main too; don't chase without new evidence
