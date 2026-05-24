Last updated: 2026-05-23

## Status

Issue #3 (SVG preview cards blank on mobile) complete and merged to main.

## Decisions made this session

- Root cause: `postProcess` stripped `width`/`height` from inline SVG, causing mobile browsers to collapse it to 0×0 in a flex container
- Fix: `width="100%"` on SVG element + CSS `display:block; width:100%; height:auto` + mobile `max-height:100%` override

## Next issues

- Check `gh issue list --repo JacobGiordano/logo-forge` for what's next

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `serve` package used as dev server for Playwright tests only
- Undo button stays disabled until a second trace is committed (by design)
