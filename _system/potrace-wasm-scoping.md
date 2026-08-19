# Scoping: swap the curve-fitting stage for potrace-wasm (issue #11)

Status: scoping only, not started. No dependency added, no code changed outside this doc.

## 0. A finding that reframes the whole issue

`buildTraceOptions()` in `js/app.js` (around line 1215) always calls `ImageTracer` with:

```js
colorsampling: 0,
numberofcolors: 2,
pal: [ {r:0,g:0,b:0,a:255}, {r:255,g:255,b:255,a:255} ],
```

This is not incidental — `preprocessImageData()` upstream already reduces the source image to a
binary `Uint8ClampedArray` mask (threshold/despeckle/hole-fill/upscale all operate on a 1-bit
`Uint8Array` mask) before it ever reaches `ImageTracer`. The app never exposes `numberofcolors > 2`
or any other preset to the UI.

Consequence: `colorquantization()`'s job, in every real invocation this app makes, is "nearest-match
each already-pure-black-or-white pixel to one of two fixed colors" — i.e. it's re-deriving the
threshold decision that already happened. The "perceptual LAB-space multi-color quantization" half
of the Illustrator-quality argument in the issue doesn't actually apply to this app's usage today;
only the corner-detection / curve-fitting half does. That's good news for scope: this is really a
**binary-bitmap-to-vector swap**, which is exactly potrace's native use case (potrace has never done
color — it's always taken a bitmap and returned single-color path data), not a multi-layer swap.

The plan below still respects the issue's ask to keep the general layering architecture intact
(so a future `numberofcolors > 2` UI could still work), but the effort/risk estimate is calibrated
to the fact that only the 2-color path is exercised today.

## 1. Integration point(s)

Call chain today, `imagedataToTracedata()` (`js/imagetracer.js:49-102`), `options.layering === 0`
branch (the one `app.js` actually uses, since `buildTraceOptions()` never sets `layering`):

```
colorquantization(imgd, options)          → { array: ii (2D palette-index grid), palette }
  per color k in palette:
    layeringstep(ii, k)                   → 0/15-coded boundary grid for pathscan
    pathscan(grid, pathomit)              → polygon paths (pixel-corner walk) + hole parent/child
    internodes(paths, options)            → midpoint nodes + right-angle enhancement
    batchtracepaths(nodes, ltres, qtres)  → tracepath()/fitseq() → line/quad Bezier segments
tracedata = { layers: [...], palette, width, height }
getsvgstring(tracedata, options)          → svgpathstring() per non-hole path → SVG string
```

Then in `js/app.js` `#trace-btn` handler (line ~1076):
```js
const tracedata = ImageTracer.imagedataToTracedata(processed.imageData, traceOptions);
const svgStr = ImageTracer.getsvgstring(tracedata, traceOptions);
const cleaned = cleanupSVG(svgStr, selectedColor, canvas.width, canvas.height, settings.pathSimplify);
const stats = collectTraceStats(tracedata, cleaned, processed);
```

**The swap point**: after `colorquantization()` produces `ii` (the indexed-color 2D grid + palette),
replace `layeringstep → pathscan → internodes → batchtracepaths` (the corner-detection/curve-fitting
stage) with a per-color-layer call into potrace-wasm. For each palette index `k`:

- Build a binary bitmap: `bitmap[j][i] = (ii.array[j+1][i+1] === k) ? 1 : 0` for `width × height`
  (this is a **new**, trivial derivation — cheaper than `layeringstep`'s 4-neighbor lookup-code grid,
  which exists only to feed imagetracer's own marching-squares walker).
- Feed that bitmap to potrace-wasm's trace call for that layer.
- Potrace's native output is SVG path `d` data (or a full `<svg>`) with its own hole handling
  already baked into the path's fill rule — it does not need `internodes`/`tracepath`/`fitseq` at all,
  those are imagetracer-specific.

**Data crossing the boundary**:
- In: a `width × height` binary bitmap per color layer (in practice, in this app, exactly one
  layer — the "dark"/foreground one — since `numberofcolors` is always 2 and `cleanupSVG` already
  discards the light/background layer's path data; see `isLightColor()` filtering at
  `js/app.js:1517-1523`).
- Out: SVG path `d` string(s) per layer, to be assembled into the same kind of `<path fill=... d=...>`
  elements `svgpathstring()` produces today, so `getsvgstring()`'s outer `<svg>...</svg>` wrapper and
  `cleanupSVG()`'s downstream merge logic don't need to change shape — only how each path's `d`
  is produced.

## 2. What stays vs. what gets replaced

**Stays, unmodified**:
- `colorquantization`, `samplepalette`, `samplepalette2`, `generatepalette`, `blur`, `checkoptions`,
  `optionpresets` — the color/threshold/palette machinery, per the issue's ask.
- `getsvgstring()`'s outer SVG assembly, `tosvgcolorstr`/`torgbastr`, `roundtodec`.
- `loadImage`, `getImgdata`, `appendSVGString`, `drawLayers` — I/O utilities, unrelated to this swap.
- All of `js/app.js`'s mask pipeline (`preprocessImageData`, Otsu threshold, despeckle, hole-fill,
  Scale2x/3x upscale) — untouched; it still produces the binary mask that feeds `colorquantization`.
- `js/upscale.js`, `js/zip.js` — untouched, different concern entirely.

**Becomes a fallback path, not deleted** (see §4 — this is a correction to a strict
stays-vs-replaced framing): `layering`, `layeringstep`, `pathscan`, `pathscan_combined_lookup`,
`pointinpoly`, `boundingboxincludes`, `batchpathscan`, `internodes`, `testrightangle`, `getdirection`,
`batchinternodes`, `tracepath`, `fitseq`, `batchtracepaths`, `batchtracelayers`. These stay in the
file as the no-wasm fallback implementation. They only become true dead code if/when a later,
separate cleanup issue decides the fallback is no longer worth maintaining — out of scope here.

**Replaced (primary path when wasm is available)**: the pathscan→internodes→tracepath chain, driven
per-layer through potrace-wasm instead.

**Needs adaptation, not a clean keep**: `svgpathstring()` currently consumes `smp.segments` (line
array of `{type:'L'|'Q', x1,y1,x2,y2,[x3,y3]}`) built by `fitseq`. It would need either (a) a second
code path that accepts a pre-built `d` string from potrace directly, bypassing segment assembly, or
(b) potrace's output parsed back into the same segment shape (wasteful, discard this option). Also
needs a **fill-rule/winding verification pass**: `cleanupSVG()` (`js/app.js:1503-1537`) merges every
non-light path's `d` into one `<path fill-rule="evenodd">`, relying on imagetracer's own hole-nesting
convention being evenodd-safe per path. Potrace's SVG backend has its own winding convention for
holes — this needs to be checked empirically (traced test logos, diffed visually) before trusting it,
not assumed from documentation.

## 3. Bundle size / load-time impact

Researched concretely (not hand-waved) against `esm-potrace-wasm` (github.com/tomayac/esm-potrace-wasm),
the actively-maintained ESM wasm build of potrace, as the leading candidate:

- npm registry `dist.unpackedSize` for `esm-potrace-wasm@0.5.1`: **98,750 bytes across 5 files**
  (source: `registry.npmjs.org/esm-potrace-wasm/latest`).
- The actual payload is dominated by a single file: `dist/index.js` is **75,989 bytes** raw
  (source: GitHub contents API, `tomayac/esm-potrace-wasm`, `main` branch). The wasm binary is
  embedded **inline in that JS file** as an encoded string, decoded and passed to
  `WebAssembly.instantiate()` at init time — there is **no separate `.wasm` asset to fetch**, no
  MIME-type/CORS concern on GitHub Pages, and no second network round-trip.
- For comparison, this repo's entire current `js/` payload: `imagetracer.js` 34,111 bytes,
  `app.js` 74,620 bytes, `upscale.js` 5,333 bytes, `zip.js` 1,691 bytes — **115,755 bytes total**,
  **~29.7 KB gzipped** (measured: 19,393 + 7,723 + 1,853 + 695 bytes gzipped respectively).
- Adding the ~76 KB `esm-potrace-wasm` file roughly **doubles total JS payload weight**
  (115 KB → ~192 KB raw). It will gzip worse than the existing hand-written JS because a large
  fraction of it is an encoded binary blob, not repetitive text — expect something in the
  ~55–65 KB gzipped range for that one file, versus ~30 KB gzipped for everything else combined.
  This is a real, noticeable increase, but not the "megabytes" territory that would actually be
  prohibitive for a client-side tool that already loads full-resolution PNGs.

**How it loads without a build step** (this project has none, and won't gain one for this): the
package ships as a real ES module (`export { potrace, init }`), not a `<script>`-global/UMD file
like the existing vendored libs. It cannot be dropped in as a fifth `<script src="...">` tag the way
`imagetracer.js`/`upscale.js`/`zip.js` are. Concretely:

- Vendor the single `dist/index.js` file into the repo (e.g. `js/vendor/potrace-wasm.js`), same
  "commit the library source, no npm install at runtime" pattern already used for `imagetracer.js`.
- Load it via a **dynamic `import()`** from inside `js/app.js` (dynamic `import()` works fine from a
  plain classic `<script>` — no need to convert `index.html`'s script tags to `type="module"`, no
  change to load order/timing for the other vendored files):
  ```js
  let potraceModule = null;
  async function loadPotrace() {
    if (potraceModule) return potraceModule;
    potraceModule = await import('./js/vendor/potrace-wasm.js');
    await potraceModule.init();
    return potraceModule;
  }
  ```
- Kick this off once, opportunistically (e.g. on first file upload, not on page load) rather than
  blocking the very first trace on a cold wasm compile — `WebAssembly.instantiate` of a ~75 KB module
  is fast (single-digit-to-low-double-digit ms) but there's no reason to put it on the critical path
  when the user is still looking at the upload dropzone.

## 4. Fallback behavior

Yes — fall back to the existing JS `pathscan`/`internodes`/`tracepath` chain, unconditionally kept
in `imagetracer.js` for this reason (see §2). Trigger conditions for falling back:
- `typeof WebAssembly === 'undefined'` (feature-detect before ever attempting the dynamic import).
- The dynamic `import()` rejects (network hiccup on GitHub Pages, ad-blocker/CSP blocking wasm, etc.).
- `potraceModule.init()` rejects (e.g. `WebAssembly.instantiate` blocked by a strict CSP some
  embedding context might impose).

On any of these, log once to the console (not spam per-trace) and route that layer through the
existing `layeringstep→pathscan→internodes→batchtracepaths` path exactly as it works today. This
means the feature is additive and safe by construction: worst case, a user on an unsupported/locked-
down browser gets exactly today's trace quality, silently, not a broken app.

## 5. Test impact

Only one spec exists today: `tests/undo-redo.spec.ts` (130 lines). Read it (did not modify it — out
of my ownership). It is entirely behavioral/status-driven, not implementation-coupled:
- Waits on `#status` text (`'Done — SVG ready ✓'`, `'Restored — SVG ready ✓'`).
- Checks `#svg-result` visibility and `#svg-meta` containing the string `'Threshold'`.
- No assertions on exact path count, segment count, byte size, or SVG path `d` content.

This means the existing suite would very likely **keep passing unmodified** through the swap itself,
as long as a trace still completes and produces the same `#status`/`#svg-meta` shape — `Scout`
wouldn't need to touch it for the swap per se. However, I'd flag two follow-on test gaps for Scout to
pick up in a separate session (not now — out of my lane and out of scope for a scoping-only issue):
1. A test that forces the wasm-unavailable path (e.g. stub `WebAssembly` away before page load) and
   asserts tracing still completes via the fallback — this is the one behavior this issue introduces
   that has no coverage today.
2. Given the wasm module load is now async and opportunistic (§3), a timing test: rapid upload →
   immediate Trace click before the module has finished loading, asserting it still resolves
   correctly rather than racing/erroring — same flavor of timing bug class as the `liveTimer` race
   fixed for issue #10 (see `HANDOFF.md`), worth guarding against by construction (e.g. `loadPotrace()`
   should be idempotent/awaitable from multiple concurrent callers, which the memoized-promise version
   above needs a small tweak to guarantee — store the in-flight promise, not just the resolved module).

## 6. Effort estimate: **M**

Not **S**: async module loading + fallback wiring, potrace parameter remapping for the existing UI
sliders (see below), and the fill-rule/winding verification in `cleanupSVG()` all need real,
empirical implementation-time verification against several real logos — this isn't a mechanical
find-replace.

Not **L**: because of the §0 finding — this app only ever exercises the 2-color/binary path today, so
the actual swap is "one binary bitmap in, one path `d` out" per trace, not a true multi-layer
re-architecture. The color-quantization/layering code the issue asks to preserve is largely inert
in current usage and needs no changes at all.

**Concrete sub-tasks**:
- Vendor `js/vendor/potrace-wasm.js`, wire dynamic `import()` + memoized init + fallback detection.
- New bitmap-extraction helper (per palette index k) feeding potrace instead of `layeringstep`.
- Adapt `svgpathstring`/`getsvgstring` (or add a parallel path) to accept potrace's `d` output.
- **Remap existing UI sliders** — `curve-fit`, `path-simplify`, `corner-smoothing` currently drive
  `ltres`/`qtres`/`rightangleenhance` via the linear formulas in `buildTraceOptions()`
  (`js/app.js:1215-1237`). Potrace's equivalent knobs are `turdsize` (despeckle, already handled
  upstream by the JS mask pipeline — likely redundant/set to 0), `alphamax` (corner smoothness) and
  `opttolerance` (curve fit tolerance) — different scales and different qualitative behavior, so the
  three sliders need new mapping formulas, tuned by eye, not a direct constant swap.
- Empirical verification pass: trace the same handful of test logos through both paths, diff visually
  for hole/winding correctness and overall shape fidelity, before trusting the wasm path as default.

**What could go wrong**:
- Fill-rule/winding mismatch producing inverted or missing holes — the single highest-risk unknown,
  must be verified empirically, not assumed from potrace's docs.
- A cold wasm init landing on the critical path of the *first* trace if the opportunistic-load timing
  isn't tuned right, making the first trace feel slower than today even though later traces are faster.
- Slider remapping producing a jarring quality/behavior cliff right at the swap point — users tuning
  `curve-fit` expecting the old linear feel.
- Bundle size (~+76 KB raw, mid-tens-of-KB gzipped) is real weight for what's currently a lean static
  page — not prohibitive, but should be called out explicitly in the PR description per CLAUDE.md's
  new-dependency rule when this is actually implemented.

## Prior art check (CLAUDE.md requirement)

Ran `git log --oneline --grep="trace" --grep="quality" --grep="potrace" -i --all` before finalizing
this plan. Results: `fefff1e`, `0885276`, `0e39084`, `130d60c`, `95cc57f`, `ec1b33a`, `110c49e`,
`f1cef7c`, `c4a9721` — all prior feature/fix commits for the *existing* imagetracer.js-based pipeline
(undo/redo, marquee selection, Scale2x/3x upscaling, live-update). **None mention potrace or a prior
evaluation of replacing the curve-fitting stage** — this is a first-time evaluation, not a
re-litigation of an earlier decision.

## Recommendation

**Proceed to a small, isolated implementation spike**, not a full commitment yet. The bundle-size
number that would have killed this outright (say, multi-hundred-KB or MB-scale wasm) didn't
materialize — ~76 KB for a single self-contained file with no separate `.wasm` asset to host is
genuinely tractable for this project, even zero-dependency-by-default. The real open question isn't
size, it's **output correctness** (the fill-rule/winding behavior in §2/§6) and **whether potrace's
traced quality on this app's specific inputs — small, mostly-monochrome logo/icon silhouettes, not
photos — actually looks better than the current tuned pipeline**, given `numberofcolors` is always 2
here already. That's not something a scoping doc can settle; it needs a spike that traces real test
logos through both paths and compares them side by side before deciding whether this becomes the new
default, an opt-in toggle, or gets shelved.
