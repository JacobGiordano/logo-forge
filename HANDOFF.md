Last updated: 2026-10-23

## Status

Issues #11-#41 complete and shipped, plus touchcancel hardening (no issue) and per-checkout Playwright ports (no issue). Suite: 96 passed.

## Decisions made this session

- #41: box-nudge was impossible (clampPanToBox constrains box-relative-to-image, same as pan). User chose padding: Center grants a per-edge `padAllowance` (source px) so the frame may extend past the image; shrink-only on pan/resize/zoom/pinch/keyboard; reset by Clear, new box, openSelectionView. Edit crop re-establishes it for a padded rect. Old "couldn't fully center" warning removed.
- Pad fill (`choosePadFill`): transparent if source edge strip >50% transparent, else median of the frame's non-subject pixels. Preview draws fill / lighter checkerboard. Auto-trim on drops padding (tight trim); off exports padded crop via `renderPaddedSourceRect`.
- touchcancel is registered/removed alongside every select-canvas touchend; onSelectDragEnd resets all gesture state.
- Playwright: port = sha1(cwd) → 20000-29999, `PLAYWRIGHT_PORT`/`PORT` override, `reuseExistingServer: false`, `--no-port-switching`; specs use `page.goto('/')`. Parallel worktree runs are now safe.

## Next issues (unfiled follow-ups)

- Center polarity flips when the subject fills >~half the box → Center no-ops silently.
- touchcancel on a one-finger draw keeps an already-valid box (same as touchend) — decide if it should discard.
- Zoom near canvas edge shifts the box (`clampBoxToCanvas`), changing its source rect and dropping padding (pre-existing).
- Center can need two clicks when the frame clips the subject; ~1 source px Y rounding.
- No padding test runs Center while zoomed in (Flint verified manually).
- `package.json` serve/start scripts still use port 4321 (manual use only).
- Color-aware tracing: on hold. `touchcancel` for pinch/pan: done.

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `preprocessImageData` is async, gated by `BILINEAR_NATIVE_SAFE_LIMIT=3500` and the #37 6000px cap; `SMALL_SOURCE_DIM=256` gates #39
- Levels runs before Otsu/threshold resolution on both native and bilinear paths
- `tests/bilinear.spec.ts:172` (3499px gate) is a known sandbox timing flake — don't chase without new evidence
