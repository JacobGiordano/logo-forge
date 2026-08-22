# Spike findings: antialiased/multi-level edge tracing vs the Adobe Live Trace gap (issue #25)

Status: spike complete. Throwaway harness kept for reproducibility (extends #12's/#13's, doesn't replace them). `js/` and `css/` untouched — `git status` confirms zero changes outside `_system/`.

## Why this spike existed

There's a persistent, previously-unexplained quality gap between this app's traced output and Adobe Illustrator's Image Trace, even after #13/#16 tuned `alphamax`/`opttolerance` and #23 added post-binarize supersampling (Scale2x-family upscale). The standing hypothesis (issue #25) was architectural: `preprocessImageData`'s Otsu threshold (`buildMask` in `js/app.js`) hard-binarizes every pixel to black/white **before** any tracing happens, destroying sub-pixel antialiasing information at the source image's true edges — information Adobe's Image Trace is presumed to use for smoother, more accurate curve fits. The ask was to scope whether tracing against a multi-level (more-than-2-band) luminance representation, instead of a single hard threshold, closes any of that gap.

## How this was run

New harness, same pattern as #12's `compare.mjs`/#13's `compare-curve-quality.mjs`: drove the **real running app** via Playwright for the "before" baseline (upload → click Trace → read the rendered result + stats out of the DOM — every "app baseline" number below is the app's actual `preprocessImageData`/`buildPotraceOptions`/potrace-wasm output, unmodified, WebAssembly available in this environment so potrace-wasm is the live default engine per #14). For the "after" experiments — which the UI has no toggle for — the harness calls the same vendored `js/potrace-wasm.js` module directly, bypassing the UI, exactly like #12 did for its Track B color-aware test.

New addition this spike needed and #12/#13 didn't: a **native-antialiased ground truth**. Every test shape is a JS canvas-drawing function parameterized by size, called once at working resolution (240×240, what gets "uploaded") and once at 4× (960×960) to produce a ground-truth reference — drawn directly at that size, never produced by upscaling the smaller bitmap, so it carries real antialiased edges at 4× the source's spatial precision. Every candidate SVG is rendered to a 960×960 canvas and diffed against this ground truth pixel-by-pixel (luma delta, %-of-canvas differing at a >40 threshold, plus RMSE) — this is the "pixel-diff against source" measurement the issue asked for. **Adobe's own Image Trace output was not available as ground truth in this environment** (no Illustrator install) — the antialiased vector-source render is the best available proxy, which is defensible here since the entire hypothesis under test is "closer to the source's true antialiased edge = closer to what Adobe achieves."

Three synthetic test shapes, generated in-page via canvas (`_system/potrace-spike/compare-antialiased-edges.mjs`, `SHAPES`), covering the geometric/flat-color vs. detailed/curved split the issue asked for, plus a topology check:

- **`geo-star`** — 6-pointed star, sharp points and concave notches, zero curves. Geometric/flat-color case.
- **`curved-icon`** — filled circle with a thin curved stroke handle (magnifying-glass-like). Detailed/curved case, stresses fine antialiased curve and thin-stroke edges.
- **`ring-holes`** — ring → hole → center dot, 3-level nesting, all circular boundaries. Topology + curve case, in the spirit of #13's bullseye nested-holes test.

`_system/potrace-spike/` test assets from #13 (the user-provided icon-sheet screenshot) were **not reused** — that input was local-only and gitignored, never committed (per #13's own findings doc), and wasn't present in this session's worktree. New synthetic shapes were generated instead, following #12's precedent of drawing test cases directly in-page rather than requiring committed binary fixtures.

Three tracing configurations tested per shape, `alphamax`/`opttolerance` held constant at #13/#16's validated "tight" preset (`0.35`/`0.05`) throughout so this spike isolates the posterization-level axis specifically, not curve-fit tuning (already covered by #13):

- **(A) App baseline** — the real production pipeline, unmodified: Otsu binarize → despeckle/hole-fill/smooth → potrace-wasm (`posterizelevel:2`, i.e. today's hard 2-level binarize).
- **(B) Multi-level, app-driven quantization** — issue ask #1. This app's own luminance math (`0.299/0.587/0.114`, alpha-composited onto white, replicating `preprocessImageData` exactly) quantizes each pixel into `levels` (4 or 8) evenly-spaced bands instead of one Otsu threshold, fed to potrace-wasm with `extractcolors:true, posterizelevel:levels`. Swept `turdsize` (0, 2) to test whether potrace's own despeckle knob can control fragmentation.
- **(C) Raw antialiased input, potrace's own posterization** — issue ask #2. The **unquantized** source image (native canvas AA, no app-side processing at all) fed directly to potrace-wasm with `extractcolors:true, posterizelevel:{4,8}`, letting potrace's internal posterization machinery do 100% of the level selection.

For (B) and (C), two output forms were measured: the **raw multi-band SVG** (every luminance band potrace found, its own `<path>`, its own fill) and a **collapsed** version — every path whose resolved fill luma is below 128 merged into one `evenodd` path, mirroring exactly what `cleanupSVG` does today. Collapsed is the fair comparison for "would this actually improve the flat single-color SVG this app ships"; raw shows what the uncollapsed multi-tone artifact looks like.

Regenerate with `node _system/potrace-spike/compare-antialiased-edges.mjs` (needs `npx serve . -l 4321` running); outputs land in `_system/potrace-spike/out-25/` (gitignored-by-convention, not committed).

## Results

### Ask #1 — multi-level mask before binarize: makes edge fidelity *worse*, not better

Across all three shapes and both tested band counts (4, 8), the multi-level collapsed output has a **larger pixel-diff against the antialiased ground truth than the app's current 2-level baseline** — the opposite of the issue's hypothesis:

| shape | app baseline diff% (rmse) | multilevel L4 collapsed diff% (rmse) | multilevel L8 collapsed diff% (rmse) |
|---|---|---|---|
| geo-star | 0.273% (7.7) | 0.597% (12.8) | 0.775% (16.7) |
| curved-icon | 0.344% (9.3) | 0.485% (12.4) | 0.653% (14.6) |
| ring-holes | 0.751% (14.0) | 1.042% (19.0) | 1.177% (21.7) |

(`turdsize:2` rows shown — the `turdsize:0` rows are worse still, see below.) Diff-against-ground-truth roughly **2–3× higher** at every band count on every shape, and it gets monotonically worse as band count increases (4 → 8 bands), not better. Visually (rendered PNGs in `out-25/`), the reason is obvious once you look at the images side by side: `geo-star`'s app-baseline edges are clean straight lines, while the multi-level-collapsed edges are a fine sawtooth of dozens of tiny micro-triangles running the full length of every edge — every 1-2px antialiasing-gradient pixel at the true boundary gets classified into its own thin luminance band, traced as its own tiny path, and (if its fill happens to land under the luma-128 collapse cutoff) merged into the "dark" silhouette as a jagged notch rather than smoothly interpolated into one boundary curve. `ring-holes`' 3-level hole topology (ring → hole → center dot) still renders **structurally correct** at every band count (consistent with #13's finding that evenodd merge handles nested topology regardless of source), but with the same sawtoothed edge degradation on every one of its three circular boundaries.

This is the core finding: naively posterizing luminance into more bands and handing the result to potrace does not reconstruct anything like Adobe's smooth sub-pixel curve fit. Adobe's Image Trace is presumed to interpolate the true sub-pixel luminance-crossing point between pixels (a continuous boundary position), whereas potrace/imagetracer's contour tracer — at any band count — still walks a **discrete pixel grid** and emits one polygon segment per pixel-boundary crossing. More bands just means more discrete boundaries close together near the true edge, each individually blocky, not one smoother boundary. Multi-level posterization and sub-pixel contour interpolation are different mechanisms; this spike confirms the former is not a substitute for the latter.

### Ask #2 — can potrace accept grayscale/AA input directly, and what does it cost

Yes, mechanically: `potrace-wasm` happily accepts the raw unquantized canvas output (real antialiasing, no app-side processing) via `extractcolors`/`posterizelevel`, no error, no special casing needed — confirming Track B's (#12) finding generalizes. But the cost structure is the same or worse than app-driven quantization:

| shape | app baseline bytes | multilevel-L4 collapsed bytes | raw-AA-direct L8 collapsed bytes |
|---|---|---|---|
| geo-star | 900 B | 1,940 B | 2,243 B |
| curved-icon | 900 B | 1,412 B | 2,556 B |
| ring-holes | 1,800 B | 2,297 B | 2,794 B |

Byte size (even after collapsing to a single flat path, and even acknowledging the same precision/rounding caveat #12/#13 both flagged — potrace's raw `d` output has no `compactPathData()`-equivalent rounding pass applied here) runs **1.5–2× larger** for multi-level and **2–3× larger** for feeding raw AA input directly, on every shape tested. Fidelity is no better either — `raw-AA` diff% is consistently *higher* than the app-driven multi-level variant at the same band count (e.g. `ring-holes` L8: 1.27% multilevel vs 1.664% raw-AA), because potrace's own posterization thresholds land in slightly different places than this app's evenly-spaced bands, with no consistent advantage either way.

### Fragmentation — Track B's (#12) speckle finding generalizes past photographic content to flat-color synthetic logos

Track B (#12) found 93% of paths were sub-100-character speckle fragments on a photographic 5-band color test image, and flagged that a real logo's JPEG artifacts/scan noise would likely make this worse. This spike shows the **opposite edge case is just as bad**: on perfectly clean, flat-color, single-shape synthetic logos with nothing but ordinary canvas antialiasing (no noise, no compression, no gradients), **86–99.6% of emitted paths are sub-100-char fragments at every tested configuration**, including with `turdsize:2` actively despeckling:

| config | geo-star frag% | curved-icon frag% | ring-holes frag% |
|---|---|---|---|
| multilevel L4, turdsize:0 | 99.3% | 98.9% | 99.1% |
| multilevel L4, turdsize:2 | 94.4% | 90.0% | 88.6% |
| multilevel L8, turdsize:2 | 90.0% | 91.3% | 86.7% |
| raw-AA, potrace's own posterize, L8 | 92.9% | 94.6% | 89.7% |

`turdsize` reduces raw byte count substantially (removing the tiniest fragments) but never gets fragmentation below ~87%, and — critically — the fragments it does remove are exactly the ones contributing the smooth micro-detail; removing them doesn't restore smoothness, it just removes detail, which is why `turdsize:0` and `turdsize:2` rows in the diff table above are both worse than app baseline, not just the noisier one. **This is not a photographic-content-only problem** — it is inherent to tracing any antialiasing gradient as discrete luminance bands: the AA ring around every edge, however thin and clean, always fragments into many tiny same-band-luminance path pieces once you ask a contour tracer to treat it as N≥3 flat regions instead of 1 hard edge.

## Recommendation: no — this is not the highest-leverage fix, and should not be scoped as a follow-up implementation issue as currently framed

All three of the issue's asks were tested and none support the architectural hypothesis:

1. **Multi-level posterization before binarize measurably degrades edge fidelity** against a native-antialiased ground truth (2–3× worse diff%, monotonically worse with more bands), on both flat-color/geometric and curved/detailed content — the opposite of what the issue predicted.
2. **potrace-wasm can technically accept grayscale/AA input directly**, but doing so is not better than app-driven quantization — comparable-or-worse fidelity, larger files.
3. **The path-count/file-size/fragmentation cost is severe and shape-independent** — 86-99%+ speckle-fragment paths and 1.5–3× larger files, confirming and generalizing #12's Track B finding well beyond its original photographic-content caveat.

The root-cause framing in the issue — "hard binarize before tracing destroys antialiasing info a smarter tracer could use" — undersells what's actually different about Adobe's approach. Multi-level *posterization* (treating the AA gradient as several more flat-color regions) and Adobe's presumed sub-pixel *contour interpolation* (finding the continuous threshold-crossing position between pixels, not classifying pixels into more discrete bins) are not the same mechanism, and this spike's evidence is that only the latter would plausibly help — throwing more discrete luminance bands at a discrete-pixel-grid contour tracer just multiplies the discreteness, visible directly in the sawtoothed collapsed-output renders in `out-25/`.

**This does not mean the underlying quality gap is unreal or unfixable — it means this specific mechanism isn't the fix.** A genuinely different direction surfaced incidentally while building the ground-truth harness for this spike, worth naming as a candidate for a future spike, not pursued further here (out of scope for this session): **supersampling the grayscale luminance data itself (e.g. bilinear upscale 2-4×) *before* the Otsu threshold, instead of after it.** Today's pipeline order is threshold → despeckle/hole-fill → Scale2x-family pixel-art upscale (`js/upscale.js`, post-binarize, per #11/#12/#23) — Scale2x infers plausible corner shapes from binary neighbor patterns, it does not reconstruct sub-pixel information already discarded at the threshold step, which is exactly the limitation issue #25 correctly diagnosed. Thresholding *after* a true (interpolating) supersample of the still-continuous grayscale signal, rather than tracing more discrete bands of it, is closer in spirit to how sub-pixel contour interpolation actually works and wasn't tested by this spike — it targets the same suspected root cause through a different, untested mechanism. **Any follow-up here should be its own scoped spike**, not an assumption that it will succeed where this one didn't; per the despeckle-before-color-tracing precedent already in HANDOFF.md, no implementation issue should be opened on an unvalidated mechanism.

**No follow-up implementation issue is recommended from this spike's own findings.** The three specific mechanisms issue #25 asked about (multi-level pre-binarize posterization, direct grayscale/AA input to potrace, quantified comparison) are now quantified and don't support building on top of them.

## What's kept vs. cleaned up

- Kept: `_system/potrace-spike/compare-antialiased-edges.mjs` (new harness — reusable for whoever picks up the bilinear-pre-supersample direction flagged above, or wants to re-verify against additional shapes before ruling this out further).
- Not committed: `_system/potrace-spike/out-25/` (generated PNGs/SVGs/`summary.json` — regenerate via the command above). Note: `_system/potrace-spike/.gitignore` previously only ignored `out/`, not this spike's `out-25/` — widened it to `out/` + `out-*/` as part of this session (a one-line addition to shared spike scratch infra, not app code) so future `out-N/`-named spike output stays gitignored automatically rather than relying on nobody ever `git add`ing it by hand.
- `js/app.js`, `js/imagetracer.js`, `js/potrace-trace.js`, `js/upscale.js`, `css/` — untouched. No app code was modified for this spike; all comparisons ran through the external harness, either against the real running app or directly against the vendored `js/potrace-wasm.js` module, per the session brief.

## Prior art check (CLAUDE.md requirement)

Ran `git log --oneline --grep="antialiase" --grep="posterize" --grep="multi-level" --grep="grayscale" -i --all` before finalizing. Only prior result: `a0dafe8` (#12 spike, Track B) — already read and directly built on above (its speckle-fragmentation finding is confirmed and generalized past photographic content by this spike). No other prior evaluation of this specific question exists.
