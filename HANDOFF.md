Last updated: 2026-05-23

## Status

Issue #1 (undo/redo) complete on branch `feat/undo-redo`. Awaiting merge approval.

## Decisions made this session

- Undo requires ≥2 traces (first trace has nothing to go back to — this is correct behavior)
- History cap: 20 entries, linear (new trace clears redo future)
- Added Playwright test infrastructure (package.json, playwright.config.ts, `serve` dev dep)
- Tests run via `npm test` from repo root; test server auto-starts on port 4321

## Next issues

- Check `gh issue list --repo JacobGiordano/logo-forge` for what's next

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `serve` package used as dev server for Playwright tests only
- Undo button stays disabled until a second trace is committed (by design)
- Button click handlers (`#undo-btn`, `#redo-btn`) must be wired explicitly — keyboard shortcut path is separate
