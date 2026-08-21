# logo-forge — Claude Operating Rules

## What this project is

Logo Forge is a browser-based raster-to-SVG converter for logo cleanup. Upload a PNG/JPG, tune trace settings (thresholding, despeckling, curve fitting), and export production-ready SVGs and PNGs in a full size set (favicons, light/dark variants, OG images). Runs entirely client-side — no server, no backend, no build step. Live at https://jacobgiordano.github.io/logo-forge/.

## Codebase structure

```
logo-forge/
├── index.html          # app shell
├── css/
│   └── styles.css
├── js/
│   ├── app.js           # main application logic
│   ├── imagetracer.js   # raster-to-SVG tracing
│   ├── upscale.js        # Scale2x/3x-family mask upscaler
│   └── zip.js            # export bundling
├── tests/
│   ├── fixtures/
│   └── *.spec.ts         # Playwright specs
├── test-results/         # Playwright output (gitignored)
├── HANDOFF.md            # session whiteboard, rewritten each ship
└── _system/SOP.md        # full agent SOP
```

## Agents

Project-local agent profiles live in `.claude/agents/`. Claude Code loads them automatically — no installation required.

**Invoke the correct agent for every task — do not work without one.**

| Agent | Owns | Must never touch |
|-------|------|-----------------|
| Aria | `css`, `js` | `test-results`, `tests` |
| Scout | `test-results`, `tests` | `css`, `js` |
| Coda | *(none — cross-cutting)* | — |
| Flint | *(none — cross-cutting)* | — |
| Rune | *(none — cross-cutting)* | — |
| Gauge | *(none — cross-cutting)* | — |
| Tempo | *(none — cross-cutting)* | — |

Aria is the sole implementation agent for all application code (markup, styles, client-side logic) — there is no frontend/backend seam in this project, so `css` and `js` are one owned domain, not two. Cross-cutting agents (Coda, Flint, Rune, Gauge, Tempo) read freely across both directories for coordination, gating, security, and review; they propose but never commit changes themselves.

## Shared contract rules

Not applicable. With a single implementation agent (Aria) owning all app code, there is no cross-agent interface to protect — no Arch agent is installed, and none is needed unless a second implementation agent is added later.

## Core rules

- NEVER silently modify files outside your assigned directory
- NEVER skip the branch check before starting work
- NEVER push to remote without explicit user authorization ("ship it")
- NEVER update HANDOFF.md before "ship it" — it is written and committed as the first act of the ship step
- Keep HANDOFF.md under ~30 lines — it is a whiteboard, not a log
- Do not introduce new dependencies without noting them in the PR description
- No lint or build step is configured for this project (plain static HTML/CSS/JS, no bundler) — verification means the Playwright suite (`npm test`) passes and the feature works in the running app
- **Each agent works exactly one issue per session, then stops and waits for explicit user authorization before starting the next one — no exceptions**
- When an issue presents multiple implementation paths, run `git log --oneline --grep="<keyword>"` for relevant terms before choosing — prior decisions are often in commit messages and are authoritative

## Technical constraints

- **Stack**: Vanilla HTML/CSS/JS — no framework, no bundler, no build step. `serve` (npm package) is used only as a local dev server for running Playwright tests against.
- **Test runner**: Playwright (`npm test` → `playwright test`)
- **Shared contract**: N/A — single implementation agent (Aria), see "Shared contract rules" above

## Phase awareness

Always check `HANDOFF.md` to know the current phase before starting work.
Do not implement Phase N+1 features during Phase N work, even if it seems easy.

## Parallel agent execution

When two agents run in parallel, they **must** operate in separate git worktrees.

**Rule:** Coda must use `isolation: "worktree"` (or manually `git worktree add`) for every parallel agent spawn.

## SOP

Full SOP: `_system/SOP.md` — read at session start.
