# Spike findings: bilinear supersample-before-threshold vs Scale2x-after (issue #27)

Status: spike complete (#27). Productionization attempted per #30 — **not wired in**; see "Issue #30: productionization findings" below for why. Throwaway harnesses kept for reproducibility (extends #12's/#13's/#25's pattern). `js/` and `css/` untouched by either #27 or #30 — `git status` confirms zero changes outside `_system/`.

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

---

## Issue #30: productionization findings (2026-08-23)

Status: **do not wire into production this session.** Parts 1 and 3 of #30's ask (real-image validity, pipeline composition) check out — in fact the mechanism holds up better than #27's clean-shape numbers suggested. Part 2 (performance at production sizes) does not check out: bilinear-presupersample crashes the browser tab outright at a plausible real-upload size, and is 3-17x slower than today's pipeline well before that crash point, with **no existing size guard in this app to prevent a user from hitting it** (`js/app.js`'s `handleFile` has no `MAX_DIM`/resize step before `canvas.getImageData` — confirmed by reading it directly, and this is true of today's shipped Scale2x-upscale path too, not a new problem introduced by this issue, but bilinear-presupersample is meaningfully more exposed to it — see below). Per #30's own instructions ("if steps 1-3 raise concerns that make productionizing premature, it's fine \[...\] to stop and report that clearly"), that's what this section does. **Flagging to Coda: loop in Tempo before any future attempt at this** — the performance numbers below are exactly the "numbers look concerning" case #30 asked to be raised explicitly rather than pushed through.

No `js/`, `css/`, or `index.html` changes were made — `git diff --stat` on this branch touches only `_system/potrace-spike/` (two new harnesses) and this findings doc. Nothing to regress; the full Playwright suite was not run as a gate for that reason (see "Test-suite note" at the end of this section for why it wasn't cleanly runnable this session, and why that doesn't block this docs-only conclusion).

### Part 1: real-image / noisy-source testing — the win holds up, doesn't regress

New harness: `_system/potrace-spike/compare-bilinear-real-images.mjs`. #27 deliberately used clean, noise-free synthetic shapes to isolate the mechanism (same rationale #25 used). This harness keeps #27's shape generators and ground-truth/diff methodology (240 native → 960 4x ground truth, same luma-delta/RMSE metric) but traces a **degraded** version of each source instead of the clean one:

- `noisy-logo`: the same `geo-star` shape, round-tripped through low-quality JPEG (`quality: 0.35`, real blocking/ringing artifacts) plus ~0.8% salt noise (scan-noise proxy), still diffed against the *clean* shape's native 4x ground truth — this measures whether bilinear-presupersample recovers a cleaner result from noisy input, or amplifies the noise into a worse one.
- `aa-wordmark`: a genuinely new case #25/#27 never had — real font-hinting anti-aliasing (`ctx.fillText`, bold Arial "LOGO" + a dot), same JPEG+noise degradation, same ground-truth methodology. Anti-aliased type is exactly the kind of source content #30 flagged as untested.
- `select-sheet-aa.png`: the existing real (non-synthetic-canvas-generated) fixture at `tests/fixtures/select-sheet-aa.png` — read-only use, no ground truth available (it's a fixed real file, not something this harness can also render at 4x natively), so only fragmentation/path-count is checked here.

Unlike #27, this harness also applies despeckle/hole-fill **at the upsampled resolution with factor²-scaled `maxArea`** to the bilinear candidate (see Part 3 below for why) — #27 skipped despeckle entirely since its shapes had nothing to despeckle; noisy/degraded content is exactly the case where that matters.

Results (diff% against clean 4x ground truth; A1/A2 = real app UI baseline, upscale off / Scale2x forced to 4x, matched resolution; C = bilinear 4x + factor²-scaled despeckle/hole-fill):

| case | A1 app default | A2 app Scale2x 4x | C bilinear 4x |
|---|---|---|---|
| noisy-logo (JPEG+salt noise) | 0.242% | 0.314% | **0.185%** |
| aa-wordmark (font AA, JPEG+noise) | 1.329% | 0.791% | **0.707%** |

Bilinear-4x beats both app baselines on both degraded cases, extending #27's clean-shape ordering (C < A2 < A1) to real degradation. **Fragmentation: 0% at every factor (2x and 4x) on every case**, including `select-sheet-aa.png` (pathCount 3, fragCount 0) — the despeckle/hole-fill-at-upsampled-resolution composition from Part 3 does its job: visually confirmed in `noisy-logo__C-bilinear-F4.png` (out-30-real/, gitignored), the salt-noise speckles visible in `noisy-logo__0-degraded-source.png` are fully absorbed with a clean star silhouette, no stray fragments. #27's central risk (does noise reintroduce #12/#25's speckle-fragment problem) does not reproduce even under real degradation, provided despeckle/hole-fill move with the resolution — they don't do this job for free, though (see Part 2).

One non-alarming oddity: `aa-wordmark`'s path count is 12 (both app baselines) vs 8 (bilinear candidates). Rendered output (`aa-wordmark__A2-app-scale2x-4x.png` vs `aa-wordmark__C-bilinear-F4.png`, both in `out-30-real/`) is visually indistinguishable — same four letters, same dot, no missing serifs or merged counters — so this reads as an SVG-structure/hole-counting difference between the two mask topologies at the interior-counter level (e.g. how "O"'s counter is split into subpaths), not a fidelity regression; the diff% numbers agree it's not a quality loss. Flagging rather than asserting confidently, since a full investigation of *why* the path count differs wasn't done this session.

### Part 3: pipeline composition — despeckle/hole-fill must move to the upsampled resolution with factor²-scaled area thresholds

The findings doc (#27) posed this as an open question with two options: run despeckle/hole-fill on the continuous luminance data before the bilinear step, or after it (at the upsampled/binarized resolution, with factor-aware thresholds). The first option isn't actually available — `removeSmallComponents`/`fillSmallHoles` (`js/app.js`) are connected-component flood fills over a *binary* mask; a continuous luminance field has no "component" to measure the area of until it's thresholded. So the only real option is the second one, and it needs to be **factor²**, not factor — `maxArea` is a pixel-count (area) threshold, and area scales with the square of a linear upsample factor. Native despeckle=24 (slider default) at 4x becomes maxArea=24×16=384 upsampled-pixel-units to represent the same real-world speck size; this session's harnesses use exactly that scaling (`despeckleNative * factor * factor` in both new harnesses) and Part 1's results confirm it produces correct output (no over-eaten fine detail, no under-cleaned noise) on real noisy content.

Corner-smoothing (`smoothMask`/`morphMask`/`refineMaskEdges`) is a related open question this session did **not** resolve: those passes are 3x3-neighborhood morphological operations, not area-threshold ones, so "factor²-scaling" doesn't directly apply — a fixed pass-count at native resolution smooths a proportionally *smaller* feature once resolution goes up 4x (1 native pixel = 4 upsampled pixels wide), meaning corner-smoothing would likely need a pass-count that scales with `factor` (not `factor²`) to produce equivalent-looking output, or it needs to run before the bilinear step instead of after (on the native mask, the way it partially could since it doesn't have despeckle's "no components before threshold" blocker — corner-smoothing already runs on a binary mask today, at native resolution, before Scale2x). This session's harnesses did not exercise corner-smoothing at all — an explicit gap for whoever picks this back up.

### Part 2: performance at production sizes — this is the blocker

New harness: `_system/potrace-spike/profile-bilinear-perf.mjs`. #27 only measured pixel-diff quality up to 960x960 (240 native x 4); this measures wall-clock cost, in-browser, on the main thread (this app has no Web Worker anywhere — confirmed by reading `js/`, all tracing/mask work runs synchronously on the UI thread today, same as production), at native upload sizes with no synthetic ceiling: 512, 1024, 2048, 3000, and 4200 (a plausible "user uploaded a full-res phone photo by mistake" size — **there is no upload size cap in this app today**, confirmed by reading `handleFile` in `js/app.js`: the source image is drawn to a canvas and read via `getImageData` at whatever its native dimensions are, no resize step exists). Each size was profiled at upscale factor 2x and 4x, comparing (a) today's production order — native Otsu + despeckle + hole-fill on the small native mask, then Scale2x-family upscale — against (b) the bilinear-presupersample candidate — continuous luminance → bilinear upsample → Otsu at the upsampled resolution → despeckle/hole-fill at the upsampled resolution with factor²-scaled thresholds (Part 3's proposed composition, so this is measuring the realistic candidate, not a stripped-down one).

| native size | factor | today (native+Scale2x) | bilinear-presupersample | ratio |
|---|---|---|---|---|
| 512x512 | 2x | 35ms | 92ms | 2.6x |
| 512x512 | 4x | 37ms | 181ms | 4.8x |
| 1024x1024 | 2x | 58ms | 180ms | 3.1x |
| 1024x1024 | 4x | 81ms | 529ms | 6.5x |
| 2048x2048 | 2x | 179ms | 577ms | 3.2x |
| 2048x2048 | 4x | 261ms | **4546ms** | 17.4x |
| 3000x3000 | 2x | 323ms | 1432ms | 4.4x |
| 3000x3000 | 4x | 504ms | **8891ms** | 17.6x |
| 4200x4200 | 2x | — | **browser tab crashed (OOM)** | — |
| 4200x4200 | 4x | — | **browser tab crashed (OOM)** | — |

Full data: `_system/potrace-spike/out-30-perf/profile.json` (gitignored, regenerate via the script).

Two things stand out:

1. **The slowdown is dominated by despeckle/hole-fill, not the bilinear resample itself.** At 2048x2048@4x, the bilinear upsample step alone is 420ms (not cheap, but not the story) — despeckle is 1270ms and hole-fill is 2525ms, together >80% of the 4546ms total. This is the direct cost of Part 3's conclusion: moving these BFS/flood-fill passes from the small native mask (where they run today, cheaply) to the large upsampled mask (16x the pixels at factor 4) multiplies their cost by roughly that same factor, since a flood-fill's cost is driven by array size, not by how much despeckling there is to do. This is a real architectural tax of the reordering, not an implementation inefficiency in this session's harness code (it's a near-verbatim copy of `js/app.js`'s own `removeSmallComponents`/`fillSmallHoles`).
2. **4200x4200 (a plausible, not hypothetical, upload size) crashes the tab outright, at both factors.** The likely cause, based on where the crash falls relative to the timing progression: the candidate pipeline allocates several full-upsampled-resolution arrays simultaneously — an 8-byte-per-pixel `Float64Array` for the continuous luminance field, plus another 8-byte-per-pixel `Float64Array` for the upsampled field, plus multiple 1-4-byte-per-pixel `Uint8Array`/`Int32Array` buffers for the despeckle/hole-fill BFS queues — where today's pipeline only ever holds a 1-byte-per-pixel mask at the upsampled size (Scale2x working on already-cleaned native data, no float arrays at any resolution). At 4200x4200x4 (16800x16800, ~282M pixels), the Float64Array pair alone is ~4.5GB; today's equivalent Scale2x output mask is a single ~282MB Uint8Array. This is a materially different memory profile, not just a slower one.

Today's shipped Scale2x-after-binarize path is not immune to the "no upload size cap" problem either — a user could already hit a large, slow Scale2x pass today — but it degrades far more gracefully (the 3000x3000@4x row above is 504ms for the existing pipeline vs 8891ms for the candidate, and it didn't crash at 4200x4200 in the portion of that run that completed before the page died). Wiring in bilinear-presupersample as a wholesale replacement, with no additional size-gating, would take an existing soft-degradation risk and turn part of its range into a hard crash.

### Recommendation

Do not wire bilinear-presupersample into the production pipeline as currently designed. The quality case (Parts 1 and 3) is genuinely strong — stronger than #27 alone showed, since it now holds up on noisy/degraded/anti-aliased real content too, provided despeckle/hole-fill move with the resolution using factor²-scaled thresholds. The blocker is entirely Part 2: a manual main-thread `Float64Array` bilinear kernel plus flood-fill despeckle/hole-fill at the upsampled resolution is not safe to ship unconditionally against an app with no upload-size cap — it crashes at sizes a real user could plausibly hit, and is 3-17x slower even at sizes well short of that.

A follow-up issue, if this is picked back up, should scope at minimum:
- **A Tempo review** of whether this is fixable within the current architecture (e.g., a hard cap on native-size × factor² before allowing bilinear-presupersample, falling back to today's Scale2x path above that cap) or whether it needs a structural change (Web Worker, chunked/tiled processing, or a faster resample — none of which exist in this codebase today for any part of the pipeline).
- **Corner-smoothing's factor-scaling**, left unresolved by this session (see Part 3).
- Whether a **conservative gated rollout** (e.g., only for native images below some size threshold, where the 2-6x slowdown at small sizes is a minor UX cost, not a crash risk) is worth doing as a smaller-scoped follow-up even if the general case isn't ready — not evaluated this session, a judgment call for whoever scopes the next issue.

### Test-suite note

No `js/`/`css`/`index.html` changes were made this session, so there is nothing for the Playwright suite to regress. `npm test` was not run as a gate for that reason. It also could not have been run cleanly in isolation against this worktree this session regardless: this worktree's dev server was intentionally started on port 4322 (not the default 4321) since another concurrently-running worktree (issue #29, `/workspace`, primary checkout) legitimately holds 4321 for its own in-progress `js/app.js`/`css/styles.css` changes (confirmed via `diff -rq` against that worktree — its `js/`/`css/` differ from this branch's, i.e. real uncommitted WIP, not a stale process) — exactly the kind of port collision `_system/SOP.md`'s parallel-worktree guidance anticipates. This worktree's `tests/*.spec.ts` files hardcode `http://localhost:4321` in `page.goto` rather than reading Playwright's configurable `baseURL`, so a config override to point at 4322 wasn't sufficient to route around the conflict without either editing test files (outside this agent's ownership) or waiting for port 4321 to free up. The new spike harnesses in this section did exercise the real production code path repeatedly against this worktree's own server on 4322 (`uploadAndTrace()`: real file upload → `#trace-btn` click → potrace-wasm engine → "Done" status, the same flow `tests/potrace.spec.ts` etc. drive) with no errors, but that's not a substitute for the official suite. Recommend Coda sequence a full `npm test` run against this worktree once port 4321 is free, though since no code changed, there's no expected outcome other than confirming the pre-existing baseline still holds.

---

## Issue #32: perf-fix investigation (2026-08-23)

Status: **partial fix found, still not ready to wire in.** #30 identified the blocker as despeckle/hole-fill's flood-fill passes running at the upsampled mask resolution, and asked whether it's fixable via (1) a Web Worker, (2) a capped/clamped effective supersample factor, or (3) a cheaper despeckle algorithm at high resolution. All three were built and measured against the same real-image test set and the same production-scale native sizes #30 used (512 through 4200, factors 2x/4x — including the two cells that OOM-crashed the tab in #30: 4200x4200 @ both factors). Direction 3 (cheap despeckle) is the strongest result — it fixes the specific mechanism #30 pinpointed, gives a real 1.8-7x speedup, and survives one of the two previously-crashing cells outright — but does not fix the *other* large allocation in the pipeline (the bilinear upsample's own float buffer), so 4200x4200@4x still fails, just gracefully instead of catastrophically. No `js/`, `css/`, or `index.html` changes were made — `git diff --stat` on this branch touches only `_system/potrace-spike/` (three new harnesses) and this findings doc.

### Environment caveat (read this before the numbers below)

This session's sandbox has ~7.7GB total system memory with only ~1.9-2.4GB free/available at the time of testing (`free -h`, `/proc/meminfo`) — a materially tighter ceiling than a typical user's desktop browser, which usually has multiple GB of uncontended headroom for a single tab. This matters for two reasons found empirically this session (not assumed):

1. **Absolute crash/success boundaries are lower here than a real user would likely see.** Treat the specific numbers below as a pessimistic lower bound on what's safe, not a precise prediction of a real user's experience.
2. **Outcomes near the memory ceiling are order-dependent and flaky even within this one session**, which is itself a finding worth taking seriously: a controlled re-run of main-thread bilinear-presupersample at 4200x4200@2x (`profile-worker-control.mjs`) *succeeded* (3208ms) on a fresh page — a cell #30 recorded as an outright crash — while 3000x3000@4x, a cell #30 measured at a clean 8891ms with zero issues, *crashed the page* in that same control run's third cell, and later *hung for 40+ seconds before being force-killed* in a completely fresh browser process during this session's cheap-despeckle perf run (`compare-cheap-despeckle.mjs`). Same code, same inputs, three different outcomes (crash / success / hang) across three attempts in the same session. This is strong evidence that bilinear-presupersample's memory behavior sits right at a cliff edge where small differences in ambient memory pressure decide crash-vs-succeed — which is itself an argument against shipping it without a real fix, independent of which specific fix is chosen.

### Direction 1: Web Worker offload — contains the failure sometimes, doesn't eliminate the ceiling

New harness: `_system/potrace-spike/profile-perf-fix-candidates.mjs` (Part A), control: `_system/potrace-spike/profile-worker-control.mjs`. The whole bilinear-upsample + despeckle/hole-fill pipeline (factor²-scaled thresholds, matching #30's validated composition) was moved into a dedicated Worker via `new Worker(blobUrl)`, with the source luminance array built on the main thread (matching how canvas `getImageData` has to work today — no `OffscreenCanvas` change tested, that's a separate, larger architectural change) and the transferable `Float64Array`/mask handed across via `postMessage(..., [buffer])`.

| native size | factor | Worker offload | outcome |
|---|---|---|---|
| 512-3000 | 2x, 4x | 91ms – 6777ms | all succeeded |
| 4200x4200 | 2x | 3219ms | **succeeded** (crashed in #30) |
| 4200x4200 | 4x | 199.5ms | **`worker-reported-error: "Array buffer allocation failed"` — a catchable error, not a tab crash** |

Taken alone this looks like a clean win. The control test (same pipeline, main thread, no Worker, but with a **fresh page per cell** — #30's original harness reused one page across its whole sweep) complicates that reading:

| cell | Worker (this session) | main thread + fresh page (control) |
|---|---|---|
| 4200x4200 @ 2x | success, 3219ms | success, 3208ms |
| 4200x4200 @ 4x | catchable error, 199.5ms | **same catchable error**, 8.7ms |
| 3000x3000 @ 4x | success, 6777.5ms | **page crashed** |

The 4200@4x catchable-failure behavior is **not unique to the Worker** — a fresh main-thread page produces the identical `Array buffer allocation failed` exception, catchable with a normal `try`/`catch`, no Worker required. That specific allocation (a `Float64Array` pair at 16800x16800, ~2.25GB each) simply exceeds what Chromium's ArrayBuffer allocator will grant in this environment regardless of which thread asks — moving it to a Worker doesn't change the ceiling, since dedicated Workers share the same renderer process and address space as their page in Chromium. Where the Worker *did* show a real, reproducible difference is 3000x3000@4x: a cell #30 measured as safely fast (504ms in the *old* Scale2x path, 8891ms for the full bilinear candidate) crashed the page on a fresh main-thread run, but succeeded in the Worker. Given the "environment caveat" section above, some of that divergence is plausibly ambient-memory-pressure noise rather than a Worker-specific effect — but a Worker-isolate crash is, in principle, more containable than a main-thread renderer crash (the isolate can be torn down and the page can catch `worker.onerror` and fall back, vs. a main-thread `OutOfMemoryError` typically taking the whole tab down), and this session's data doesn't contradict that. **Net: a Worker is worth keeping in any real implementation for the UI-responsiveness win alone (despeckle/hole-fill no longer blocks the main thread, matching #32's ask), and it plausibly buys a little extra headroom/containment at the margin — but it does not fix the fundamental memory ceiling.** A single allocation big enough to exceed the browser's ArrayBuffer limit fails the same way whether it's requested from the main thread or a Worker.

### Direction 2: capped effective supersample factor — safe, but the cap eats the whole benefit at exactly the sizes that matter

Same harness, Part B. Instead of a fixed requested factor, `effectiveFactor = min(requestedFactor, outputCap / nativeSize)` — the upsampled output resolution is clamped to a fixed pixel-dimension ceiling regardless of native size or requested factor. Two ceilings tested, full 512-4200 x 2x/4x grid:

| native size | requested | cap=2048 effFactor | cap=2048 time | cap=4096 effFactor | cap=4096 time |
|---|---|---|---|---|---|
| 512 | 2x/4x | 2 / 4 | 59-209ms | 2 / 4 | 59-205ms |
| 1024 | 2x/4x | 2 / 2 | 204-207ms | 2 / 4 | 160-682ms |
| 2048 | 2x/4x | 1 / 1 | 188-201ms | 2 / 2 | 634-609ms |
| 3000 | 2x/4x | 0.683 / 0.683 | 174-178ms | 1.365 / 1.365 | 707-764ms |
| 4200 | 2x/4x | 0.488 / 0.488 | 173-289ms | 0.975 / 0.975 | 712-720ms |

Every cell at both caps succeeds quickly (all under 800ms, vs. 4546-8891ms or an outright crash for the uncapped candidate at comparable sizes in #30). But look at the `effFactor` column: at cap=4096 — the more generous of the two — a native 4200x4200 upload gets an effective factor of **0.975**, i.e. the bilinear step is not supersampling at all, it's *downsampling by a hair*. At cap=2048, anything at or above native 2048 collapses to effFactor ≤1. The two native sizes #30 specifically flagged as the realistic-upload risk (3000, 4200) are exactly the sizes where the cap forces the effective factor below 1 — meaning bilinear-presupersample's entire quality win (validated in #27/#30 at factor ≥2) evaporates precisely where the memory risk was highest. A cap makes this mechanism *safe* but not *useful* at the sizes that motivated #30's real-image testing in the first place; it would only add value for uploads roughly ≤1024-2048px, where the uncapped path was never in danger of crashing anyway (2048@4x was 4546ms uncapped — slow, not a crash). **Net: capping is a valid safety net, not a fix — worth keeping as a hard ceiling underneath whichever other mechanism is chosen (defense in depth), but not sufficient on its own to make bilinear-presupersample deliver its quality win at realistic upload sizes.**

### Direction 3: cheap block-approximate despeckle — fixes the identified root cause, doesn't fix the other one

New harness: `_system/potrace-spike/compare-cheap-despeckle.mjs`. #30 pinpointed despeckle/hole-fill's flood-fill as the dominant cost because `removeSmallComponents`/`fillSmallHoles` each allocate a `visited` `Uint8Array` **and** an `Int32Array` BFS queue at the full upsampled resolution — at 4200x4200@4x (16800x16800, ~282M px) that queue alone is ~1.1GB, on top of the mask, allocated twice (despeckle, then hole-fill). This candidate never allocates a BFS buffer at the upsampled resolution at all:

1. Downsample the fine (upsampled+thresholded) mask back to **native** resolution via majority vote per `factor × factor` block.
2. Run the exact same `removeSmallComponents`/`fillSmallHoles` (copied verbatim from `js/app.js`) on this small native-resolution mask, with native-unit `maxArea` (no factor² scaling needed — this step never leaves native resolution, so it's the same cost profile as today's shipped pipeline).
3. Apply the native-resolution flip *decisions* back onto the fine mask: only blocks whose coarse vote changed get flattened to the new value; untouched blocks keep their bilinear-derived sub-pixel edge exactly as-is.

**Perf** (full grid, `full` = #30's validated high-res-despeckle composition, `cheap` = this candidate; `full` skipped at native 4200 rather than re-attempted, since #30 already established it OOM-crashes there and this session's own attempt at 3000x3000@4x `full` hung for 40s and had to be force-killed, confirming it's not worth re-running for no new information):

| native size | factor | full totalMs | cheap totalMs | speedup |
|---|---|---|---|---|
| 512 | 2x | 96.2ms | 30.6ms | 3.1x |
| 512 | 4x | 390.9ms | 54.8ms | 7.1x |
| 1024 | 2x | 171.6ms | 94.6ms | 1.8x |
| 1024 | 4x | 704ms | 174.2ms | 4.0x |
| 2048 | 2x | 566.2ms | 266.3ms | 2.1x |
| 2048 | 4x | 3114.3ms | 753.8ms | 4.1x |
| 3000 | 2x | 1343.9ms | 587.2ms | 2.3x |
| 3000 | 4x | **timeout (40s, force-killed)** | 1886.3ms | — |
| 4200 | 2x | skipped (known OOM, #30) | **1034.3ms — succeeds** | — |
| 4200 | 4x | skipped (known OOM, #30) | `Array buffer allocation failed` (10ms, catchable) | — |

Cheap despeckle is 1.8-7.1x faster everywhere it was compared directly, and **succeeds at 4200x4200@2x** — one of the two cells #30 recorded as an outright OOM crash. At 4200x4200@4x it still fails, but the failure mode changed: instead of a tab crash or hang, it's the same `Array buffer allocation failed` exception seen in Direction 1, thrown in 10ms. That's the giveaway for *why* it still fails there: cheap despeckle removes the despeckle-stage's own huge buffers, but the bilinear-upsample step's `Float64Array` pair (2.25GB each at 16800x16800) is untouched by this fix and is a separate allocation that hits its own ceiling regardless of what despeckle algorithm runs afterward. This cleanly isolates the pipeline into two independent memory problems #30's single "despeckle dominates" framing had bundled together: despeckle/hole-fill's BFS buffers (fixed by this candidate) and the bilinear upsample's float buffer (not addressed by any of this issue's three directions — would need its own fix, e.g. processing the upsample in tiles/strips instead of one full-image float array, out of scope for what #32 asked to investigate).

**Quality** (same real-image methodology as #30 Part 1 — `noisy-logo`, `aa-wordmark`, JPEG+salt-noise degraded, WORK_SIZE 240, diffed against clean 4x/960px ground truth):

| case | factor | full: diffPct / fragCount | cheap: diffPct / fragCount |
|---|---|---|---|
| noisy-logo | 2x | 0.192% / 0 | 0.192% / 0 (bit-identical) |
| noisy-logo | 4x | 0.185% / 0 | 0.185% / 0 (bit-identical) |
| aa-wordmark | 2x | 0.762% / 0 | 0.760% / **1** |
| aa-wordmark | 4x | 0.707% / 0 | 0.711% / **3** |

`noisy-logo` is bit-identical between `full` and `cheap` — the block-vote decisions matched pixel-perfect BFS exactly. `aa-wordmark` (font anti-aliasing, more small/thin features than the star shape) is where the approximation shows: diffPct is statistically unchanged (≤0.005 percentage points either direction — not a real fidelity loss), but `cheap` introduces 1-3 small stray fragment paths that `full`'s exact per-pixel BFS didn't have (pathCount 9-11 vs a clean 8). This is the predicted failure mode of majority-vote downsampling: a speck or thin feature straddling a native-pixel block boundary can fail to trigger the majority vote in either adjacent block, surviving as an untouched sliver. It is a real, non-zero regression from #30's "0% fragmentation at every factor/case" result — but it is nowhere near #12's/#25's 86-99.6% fragmentation catastrophe; it's 1-3 extra tiny paths on an otherwise-correct 8-path topology, not a structural breakdown. Whether that's acceptable would depend on tuning the majority-vote threshold (currently a flat 50%, e.g. a stricter "any foreground pixel in the block counts as foreground" rule for despeckle's removal side would likely close this gap at some cost to despeckle strength) — not explored this session, flagged as follow-up work.

### Recommendation

Direction 3 (cheap block-approximate despeckle) is the one worth pursuing further — it's the only candidate that reduces the actual memory footprint rather than relocating or capping around it, it delivers a real and substantial speedup (1.8-7.1x) everywhere, and it recovers one of #30's two crash cells outright (4200x4200@2x) with a small, quantified, non-catastrophic quality cost on one of two real-image test cases. It should be **combined with Direction 1** (Worker offload, for the UI-responsiveness win #32 explicitly asked about and the plausible-but-unproven extra isolation margin) and **Direction 2** (a hard output-resolution cap as a defense-in-depth safety net, sized generously enough — e.g. above 4096 — that it doesn't neuter the quality win at the native sizes that matter, but still exists as a backstop). None of the three, alone or combined, fixes the bilinear-upsample step's own float-buffer allocation at native 4200 @ factor 4 — that remains a hard failure (now gracefully caught rather than a crash/hang, which is itself real progress) and would need a fourth, unexplored mechanism (tiled/strip processing of the upsample step) to close entirely.

**This is exactly the "numbers look concerning, loop in Tempo" case #30 flagged and #32 was scoped around.** Recommend Coda route this to Tempo before any implementation attempt, specifically to weigh in on:
- Whether the environment caveat above (flaky crash/success/hang outcomes for the *same* cell across repeated attempts, even in this one investigation session) is disqualifying on its own, independent of which fix is chosen — a mechanism whose failure mode is nondeterministic under memory pressure is a harder thing to gate safely than one with a clean, reproducible threshold.
- Whether the majority-vote threshold in Direction 3's `cheapDespeckle` (currently a flat "≥50% of the block is foreground") should be tuned/asymmetric between despeckle and hole-fill to close the `aa-wordmark` fragmentation gap before this is considered production-ready.
- Whether a tiled/strip bilinear-upsample (never explored this session, needed to fix the still-unsolved 4200@4x float-buffer ceiling) is worth scoping as connected follow-up work, or whether a Direction-2-style cap at that specific boundary (i.e., cap the *bilinear step's own* input, not just the despeckle stage) is an acceptable stopgap.

### What's kept vs. cleaned up

- Kept: `_system/potrace-spike/profile-perf-fix-candidates.mjs` (Worker offload + capped-factor grid), `_system/potrace-spike/profile-worker-control.mjs` (main-thread/fresh-page control for the Worker comparison), `_system/potrace-spike/compare-cheap-despeckle.mjs` (block-approx despeckle perf + quality harness) — all reusable for whoever scopes a real implementation issue.
- Not committed: `_system/potrace-spike/out-32-perf/`, `_system/potrace-spike/out-32-cheap-despeckle/` (generated JSON/PNGs, gitignored via the existing `out-*/` pattern — regenerate via the commands in each script's header comment).
- `js/app.js`, `js/imagetracer.js`, `js/potrace-trace.js`, `js/upscale.js`, `css/` — untouched. No app code was modified for this spike; all three candidate mechanisms exist only inside the three harnesses' `page.evaluate`/Worker blocks, run against direct potrace-wasm/synthetic-canvas calls, matching #27/#30's established pattern. No toggle, no Worker file, and no size cap was added to the live app.

### Prior art check (CLAUDE.md requirement)

Ran `git log --oneline --all --grep="worker" --grep="Worker" --grep="capped" --grep="cap " --grep="despeckle" --grep="perf" -i` before finalizing. No prior attempt at any of the three directions exists; the only hits are #30's own findings commit, #26's tooltip work (unrelated "cap" false-positive), #19's Otsu clamp fix, #18's selection-UI tests, #4's original Scale2x upscaler (already the baseline #27/#30 compare against), and an unrelated mobile-layout fix — none overlap with Worker offload, capped supersample resolution, or block-approximate despeckle.
