# Spike findings: bilinear supersample-before-threshold vs Scale2x-after (issue #27)

Status: spike complete. Throwaway harness kept for reproducibility (extends #12's/#13's/#25's pattern). `js/` and `css/` untouched — `git status` confirms zero changes outside `_system/`.

## Why this spike existed

Issue #25 tested whether tracing against a multi-level/posterized luminance representation closed the quality gap between this app's output and Adobe Illustrator's Image Trace. It didn't (2-3x worse pixel-diff, worse with more bands, reproduced #12's speckle-fragment problem even on clean synthetic shapes). While building #25's ground-truth harness, a **different**, untested mechanism aimed at the same root cause (sub-pixel edge information destroyed at Otsu-threshold time) surfaced and was explicitly flagged as unproven: bilinear-interpolate the *continuous* grayscale luminance data **before** thresholding — true supersampling of continuous source data — then binarize at the higher resolution, instead of today's production order (Otsu threshold → despeckle/hole-fill → Scale2x-family pixel-art upscale, `js/upscale.js`, which runs *after* binarize and therefore cannot reconstruct sub-pixel information already discarded at threshold time). Issue #27 scoped this as its own spike, per the despeckle-before-color-tracing precedent (don't assume an unvalidated mechanism will work).

## How this was run

New harness, same pattern as #25's `compare-antialiased-edges.mjs`: the **same three synthetic test shapes** (`geo-star`, `curved-icon`, `ring-holes` — identical generator code, copied verbatim for direct comparability, not reimplemented from scratch) and the **same ground-truth methodology** — each shape drawn natively at 240×240 (working resolution) and independently at 960×960 (4×, native-antialiased ground truth, never produced by upscaling the smaller bitmap), every candidate SVG rendered to a 960×960 canvas and diffed against that ground truth pixel-by-pixel (luma delta, %-of-canvas differing at a >40 threshold, plus RMSE). `alphamax`/`opttolerance` held constant at the #13/#16/#25-validated "tight" preset (`0.35`/`0.05`) throughout, isolating the supersample-mechanism axis from curve-fit tuning.

Four configurations tested per shape, all via potrace-wasm (the app's default engine per #14):

- **(A1) App baseline, default settings** — real production pipeline via the live UI (Playwright upload → click Trace → read DOM), upscale-before-trace left at its HTML default ("Off" = 1×). Same configuration #25's app-baseline row used.
- **(A2) App baseline, Scale2x-family upscale forced to 4×** — same production pipeline, upscale-before-trace slider set to 4× via the UI, landing at the **same final resolution (960×960) as both the ground truth and the bilinear-4× variant below**. This is the controlled, resolution-matched comparison the issue asks for: same target resolution, two different mechanisms for getting there (post-binarize pattern-matched integer upscale vs pre-binarize continuous interpolation).
- **(B) Multi-level posterization, #25's ruled-out approach** — not re-run; #25's own numbers reused verbatim below per this issue's instruction, since #25's harness and shapes are identical to this one.
- **(C) Bilinear-then-threshold, factor 2× and 4×** — new code, direct potrace-wasm call (bypassing the UI, no toggle exists for this): (1) compute **unrounded** grayscale luminance from the 240×240 source using the app's exact luminance math (`0.299/0.587/0.114`, alpha-composited onto white, replicating `preprocessImageData` in `js/app.js`) — deliberately skipping `preprocessImageData`'s `Math.round()`/`Uint8Array` quantization step, since rounding before interpolating would itself throw away the sub-pixel precision under test; (2) manual bilinear resampler (not `canvas.drawImage`, whose upscale filter quality is implementation-defined across browsers — a hand-written bilinear kernel keeps the algorithm under test exactly specified and reproducible) upsamples that continuous field by the factor; (3) Otsu's threshold computed and applied **at the upsampled resolution** — issue #27's literal ask, "then binarize at the higher resolution." `turdsize` swept 0/2 on potrace's side, matching #25's sweep methodology.

One methodology fix made mid-spike, worth recording: the first run fed potrace-wasm's **raw** multi-path SVG output directly into the pixel-diff, and got nonsense numbers (20-38% diff, an order of magnitude worse than even #25's ruled-out approach). Investigation showed potrace-wasm's `extractcolors`/`posterizelevel:2` machinery does not reliably pick pure `#000000`/`#ffffff` even from a strictly-binary (0/255) input PNG when called directly — it returned `#2B2B2B` as the "dark" representative color on one case, which the app's real production path never surfaces because `js/potrace-trace.js`'s own cleanup pass normalizes it, but a direct potrace-wasm call (same thing #25's B/C configurations did) does not. #25 had already anticipated exactly this and built `collapsedMergeSvg` (merge every path whose resolved fill luma is below 128 into one flat `fill="#000000"` evenodd path — mirrors this app's `cleanupSVG`) for precisely this reason; this spike's first draft omitted it because the bilinear mask is already flat 2-color and that step seemed unnecessary. It wasn't — the same normalization was added here too, after which the numbers below are self-consistent and match what a real export would look like.

Regenerate with `node _system/potrace-spike/compare-bilinear-presupersample.mjs` (needs `npx serve .` running — see the `BASE_URL` comment at the top of the file, the harness had to target a non-default port this session because a concurrent agent's worktree already held port 4321). Outputs land in `_system/potrace-spike/out-27/` (gitignored via the existing `out-*/` pattern, not committed).

## Results

### Pixel-diff against ground truth: bilinear beats both the resolution-matched Scale2x baseline and #25's ruled-out multi-level approach, on every shape

| shape | A1 app default (off) | A2 app Scale2x 4× (matched res) | B #25 multilevel L4 collapsed | C bilinear 2× | C bilinear 4× |
|---|---|---|---|---|---|
| geo-star | 0.335% (rmse 9.52) | 0.280% (rmse 7.42) | 0.597% (rmse 12.8) | **0.157%** (rmse 4.30) | **0.156%** (rmse 3.62) |
| curved-icon | 0.450% (rmse 12.22) | 0.326% (rmse 9.00) | 0.485% (rmse 12.4) | **0.222%** (rmse 5.26) | **0.181%** (rmse 4.11) |
| ring-holes | 1.152% (rmse 20.90) | 0.603% (rmse 12.18) | 1.042% (rmse 19.0) | **0.566%** (rmse 9.52) | **0.500%** (rmse 7.80) |

At the resolution-matched comparison that isolates the mechanism under test (A2 vs C bilinear-4×), bilinear wins on every shape: **~1.8× lower diff% on geo-star, ~1.8× on curved-icon, ~1.2× on ring-holes**, and RMSE drops similarly (7.42→3.62, 9.00→4.11, 12.18→7.80). Against #25's ruled-out multi-level approach the margin is larger still (3-4× lower diff% on geo-star/curved-icon). This is the opposite of #25's result and the outcome the issue's root-cause hypothesis predicted: interpolating the continuous signal before a single hard threshold preserves the true sub-pixel edge position; posterizing it into more discrete bands (#25) does not.

Visual confirmation in `out-27/`: the Scale2x-4× renders (`*__A2-app-scale2x-4x.png`) show visible small straight-line facets around every curve (the circle in `curved-icon`, both circles and the boundary rings in `ring-holes`) — consistent with Scale2x being a pattern-matching integer upscaler that extends existing corner patterns rather than reconstructing a true curve. The bilinear renders (`*__C-bilinear-F4.png`) show visibly smoother, less faceted curves at the same final resolution.

### Fragmentation check (#12/#25's dominant failure mode): does not reproduce

This was the central risk this spike was asked to check. It does not reproduce:

| config | geo-star | curved-icon | ring-holes |
|---|---|---|---|
| bilinear 2×, turdsize 0 or 2 | pathCount 2, fragCount 0, **0.0%** | pathCount 2, fragCount 0, **0.0%** | pathCount 4, fragCount 0, **0.0%** |
| bilinear 4×, turdsize 0 or 2 | pathCount 2, fragCount 0, **0.0%** | pathCount 2, fragCount 0, **0.0%** | pathCount 4, fragCount 0, **0.0%** |
| (for reference) app baseline pathCount | 2 | 2 | 4 |

Zero sub-100-character fragment paths at every tested factor/turdsize combination, on every shape — a direct contrast with #25's 86-99.6% fragmentation on the same shapes. `turdsize` (potrace's own despeckle knob) made no measurable difference (identical byte counts and diffs at turdsize 0 vs 2 in every cell), consistent with there being nothing to despeckle. Raw path count exactly matches each shape's known-good production path count (2/2/4) at every factor, with no growth from 2× to 4×. The mechanism is different from #25's in a way that plausibly explains this: multi-level posterization classifies each of many thin antialiasing-gradient pixels into its own discrete luminance band, and each band-to-band pixel boundary becomes its own tiny traced path — inherent to treating one soft edge as N≥3 flat regions. Bilinear-then-threshold still produces exactly **one** hard edge per boundary (`posterizelevel:2`, same as production) — it only moves *where* that single edge falls, at sub-source-pixel precision, rather than multiplying the number of edges. That distinction is exactly why #25's failure mode doesn't carry over: this mechanism was never at risk of it for the reason #25 diagnosed, and the data confirms that reasoning.

### File size: bilinear's collapsed output is smaller than the Scale2x-matched baseline, not larger

| shape | A2 Scale2x 4× (KB) | bilinear 4× collapsed (bytes) | bilinear 4× raw (bytes) |
|---|---|---|---|
| geo-star | 5.1 KB | 4,981 B (**4.9 KB**) | 10,156 B |
| curved-icon | 2.9 KB | 2,892 B (**2.8 KB**) | 5,993 B |
| ring-holes | 7.8 KB | 5,588 B (**5.5 KB**) | 11,424 B |

Bilinear's collapsed (flat, export-ready) output is slightly *smaller* than the Scale2x-4× baseline on every shape, despite being more accurate — the opposite of #25's multi-level finding (1.5-3× *larger* for worse fidelity) and opposite of what a naive "more resolution = more path data" assumption would predict. Caveat carried over from #25/#12: this is potrace's raw `d` output with no `compactPathData()`-equivalent rounding pass applied (that's a `js/app.js`-only step, not exercised by a direct potrace-wasm call) — real production export sizes would likely be smaller still on both sides, but the relative comparison (bilinear ≤ Scale2x-matched) should hold.

### Otsu threshold and topology sanity checks

Every shape/factor combination converged to the identical Otsu threshold (128) when computed at the upsampled resolution. This looks suspicious at first glance (6 different geometries, same number, every time) but is explained by the test shapes themselves: pure `#000` fill on pure `#fff` background with ordinary canvas antialiasing produces a near-perfectly-symmetric bimodal luminance histogram regardless of shape, and Otsu's threshold is primarily a function of that histogram's shape, not the resolution it's computed at or the silhouette's geometry — not a bug, just a property of clean synthetic test content. `ring-holes`' 3-level nesting (ring → hole → center dot) traced with correct topology at every factor (pathCount 4, matching production exactly) — see `ring-holes__C-bilinear-F4.png` in `out-27/`.

### Reproduction-variance caveat

This harness's A1 numbers (app baseline, upscale off) are systematically ~1.2-1.5× higher than #25's originally-published numbers for the identical shapes/settings (e.g. geo-star 0.335% here vs 0.273% in #25; ring-holes 1.152% here vs 0.751% in #25), likely environment/version drift between sessions (potrace-wasm or Chromium point release) rather than a methodology error — the shape-generation and diff code are copied verbatim from #25. This doesn't undermine the conclusion above: every comparison this spike's recommendation rests on (A1/A2/C) was measured **within the same session, same browser instance, same potrace-wasm build**, so the internal ordering (C < A2 < B, C < A1) is apples-to-apples even though the absolute A1 numbers don't bit-match #25's old table. The B (#25 multilevel) row in the main table above is reused from a different session per this issue's own instruction and should be read as order-of-magnitude comparable, not a bit-exact replay.

## Recommendation: yes — this mechanism is worth productionizing, scope a real implementation issue

Unlike #25 (and #12's Track B), this spike's evidence supports the issue's hypothesis on all three of the checks it asked for:

1. **Pixel-diff against ground truth improves**, not degrades, at the resolution-matched comparison (A2 Scale2x-4× vs C bilinear-4×) — 1.2-1.8× lower diff%, 1.6-2.0× lower RMSE, on all three shapes (geometric/flat-color, detailed/curved, and topology/nested-hole cases).
2. **No reintroduction of #12/#25's speckle-fragment problem** — 0% fragment paths at every factor/turdsize combination tested, path counts matching production's known-good topology exactly.
3. **File size does not regress** — collapsed bilinear output is marginally smaller than the Scale2x-4× baseline, not larger, at better fidelity.

This is a mechanistically different transform from #25's (single edge relocated at sub-pixel precision, vs. many edges introduced by posterization), and the data bears out the distinction the issue asked to test.

**What a follow-up implementation issue would need to scope, not yet answered by this spike:**

- **Real (non-synthetic) source images.** All three shapes here are clean, noise-free, single-color canvas vector drawings — deliberately, to isolate the mechanism from JPEG artifacts/scan noise per #12's/#25's precedent. A real uploaded logo (compression artifacts, anti-aliased screenshot text, multi-region designs) has not been tested against this mechanism and could behave differently, particularly around noise amplification during interpolation.
- **Performance at production image sizes.** This spike's shapes are 240×240 (matching #25's convention) upsampled to at most 960×960; a real upload could be much larger, and bilinear interpolation of a large continuous float array (this spike's manual kernel, not GPU-accelerated) is more compute per pixel than Scale2x's simple neighbor-pattern lookup. Not benchmarked here — worth a Tempo pass before shipping, especially since `upscaleFactor` already goes up to 4× in the UI and users can chain it with large uploads today.
- **Interaction with `despeckle`/`hole-preservation`/`cornerSmoothing`.** Production's `preprocessImageData` runs these on the binary mask, with area thresholds tuned in native-resolution mask-pixel units (see `js/app.js`'s comment on this). This spike didn't exercise them (matching #25's approach for synthetic shapes) — a real implementation would need to decide whether these run at native resolution before the bilinear step (on the *continuous* luminance data, which doesn't have "small components" as a concept) or after (at the upsampled/binarized resolution, requiring factor-aware area thresholds, similar to the note already in `preprocessImageData` about why Scale2x runs after these passes today).
- **Where this replaces vs. composes with Scale2x.** This spike compared bilinear-before-threshold against Scale2x-after-threshold as alternatives at the same final resolution. It did not test running both (bilinear supersample, threshold, *then* Scale2x on top) — plausible but untested, and not obviously beneficial once the edge is already at sub-pixel precision.
- **Otsu recomputation cost/behavior on non-synthetic histograms.** This spike recomputed Otsu at the upsampled resolution; on a real multi-region image the histogram at 4× the pixel count is a straightforward cost, not expected to be a correctness issue, but not verified against non-bimodal real-world histograms.

## What's kept vs. cleaned up

- Kept: `_system/potrace-spike/compare-bilinear-presupersample.mjs` (new harness, reusable for whoever scopes the follow-up implementation issue or wants to test against real uploaded images before productionizing).
- Not committed: `_system/potrace-spike/out-27/` (generated PNGs/SVGs/`summary.json`, gitignored via the existing `out-*/` pattern — regenerate via the command above).
- `js/app.js`, `js/imagetracer.js`, `js/potrace-trace.js`, `js/upscale.js`, `css/` — untouched. No app code was modified for this spike; the bilinear-resample/Otsu code exists only inside the harness's `page.evaluate` block, run against a raw potrace-wasm call, exactly like #25's B/C configurations. No toggle was added to the live app.

## Prior art check (CLAUDE.md requirement)

Ran `git log --oneline --grep="bilinear" --grep="supersample" --grep="pre-threshold" --grep="interpolat" -i --all` before finalizing. Only prior result: `ec1b33a` (#4, the original Scale2x/3x perceptual mask upscaler + supersampled tracing feature — already read and directly contrasted with above, since it's the post-binarize mechanism this spike's bilinear approach is compared against). No prior evaluation of pre-threshold bilinear supersampling exists.
