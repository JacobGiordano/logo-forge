Last updated: 2026-10-23

## Status

Issues #11-#40 and #33 complete and shipped, plus drop-to-replace (no issue) and a non-image drop error message (no issue). Suite: 80 passed, 1 known flake (see Gotchas).

## Decisions made this session

- Drop-to-replace: `#dropzone` is hidden after load, so its drop handlers stopped firing and the browser default took over. Moved file-drop handling to window-level dragenter/dragover/dragleave/drop (only for drags carrying `'Files'`), all routed through `handleFile` — single code path; `#dropzone` handlers now only toggle its highlight.
- In-page drags (e.g. the `<img>` thumbnail, which Chrome reports as `'Files'`) are ignored via a document-level `dragstart` flag.
- `#drop-overlay` ("Drop to replace image") shows only once an image is loaded; `pointer-events:none`, depth-counter to avoid flicker. Needs explicit `#drop-overlay[hidden]{display:none}` because its `display:flex` otherwise beats `[hidden]`.
- Non-image drop: `handleFile` now rejects non-image (or empty-type) files up front with `setStatus('Not an image: "<name>" — please drop a PNG or JPG file.', 'err')`, matching #37's oversize error; no state touched. No-file drops still return silently.
- #33 (Scout): `tests/tooltips.spec.ts` (16 tests, incl. #28 hover-scope regression + path-simplify copy/behavior guard); `tests/drop-replace.spec.ts` (13 tests) covers drop-to-replace.
- State on replace is identical to the replace-file input (by construction): clears remembered crop only; undo history, Levels, settings, and trace output persist — pre-existing behavior, left as-is.

## Next issues

- Scout: `playwright.config.ts` hardcodes port 4321 with `reuseExistingServer: true` — parallel worktree test runs share one server and test each other's code. Needs per-worktree port or no reuse before the next parallel dispatch.
- Color-aware tracing: on hold per user request.
- Possible future: `touchcancel` handling for pinch/pan (flagged in #23, not urgent).

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `preprocessImageData` (`js/app.js`) is async, gated by `BILINEAR_NATIVE_SAFE_LIMIT=3500` and the #37 upload cap at 6000px — verify at real upload sizes
- `SMALL_SOURCE_DIM=256` gates #39's relaxed smoothMask/despeckle — tune both size tiers
- Levels (`applyLevels()`) runs before Otsu/threshold resolution on both native and bilinear paths
- `tests/bilinear.spec.ts:172` (3499px gate) is a known pre-existing sandbox timing flake — fails on unmodified main too; don't chase without new evidence
