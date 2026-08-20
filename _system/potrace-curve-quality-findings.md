# Spike findings: potrace curve-fitting quality on real content (issue #13)

Status: spike complete. Throwaway harness kept for reproducibility (extends #12's, doesn't replace it). `js/` and `css/` untouched — `git status` confirms zero changes outside `_system/`.

## Why this spike existed

#12 found potrace-wasm "visually indistinguishable" from the current `imagetracer.js` tracer, but only on 3 synthetic shapes (checkerboard, donut, blob) at library-default settings on both sides — never on real detailed content, and never with potrace's own quality knobs (`alphamax`, `opttolerance`) actually varied. This spike closes both gaps, using the user's own goal as the bar: best possible B&W raster-to-SVG conversion, color tracing out of scope.

## How this was run

Same harness pattern as #12: drove the **real running app** end-to-end with Playwright (`_system/potrace-spike/compare-curve-quality.mjs`, extends `compare.mjs`, reuses its coordinate-transform-carrying + inherited-fill evenodd merge logic verbatim rather than re-deriving it) — upload → click Trace → read the rendered result back out of the DOM. Every "app" number below is the app's actual `preprocessImageData`/`buildTraceOptions`/`cleanupSVG` output.

Test input: three crops from the user-provided 512-icon reference sheet (`_screenshots/ChatGPT Image Aug 18, 2026, 02_17_02 AM.png`, 1254×1254, gitignored, local-only — not committed, same treatment as #12's `out/`). Each crop is 234×158px (kept under the app's 256px `SELECT_SKIP_MAX_DIM` so upload skips the marquee-selection view and goes straight to trace, matching how a real user would crop-and-drop a small region):

- **`sharp-corners`** — UP/DOWN/LEFT arrows + 3 diagonal arrows. Pure right-angle/acute geometry, zero curves. Best case for corner-sharpness comparison.
- **`fine-detail`** — BRUTE(fist)/BURN(flame)/CACHE(stack) + CLOAK(hooded figure)/CLOSE(x-circle)/COMMAND(crown). Dense small glyphs mixing sharp points and curves, plus small text labels under every icon.
- **`nested-holes`** — TAG/TARGET/TERMINUS + TRACE/TRACK/TRIGGER. **TARGET and TRACK are bullseye icons: filled ring → hole → filled center dot — real 3-level fill/hole/island nesting**, not just a single hole. This is a better test of the topology #12 flagged as untested than a literal letterform: no standard Latin letter actually has hole-in-hole (island-inside-a-counter) topology — letters like "B" have two side-by-side holes at the same nesting depth, not nested inside each other. A bullseye icon is the real thing.

Potrace tested at three tuning points per case, not just default-vs-default:
- **default** (library defaults): `alphamax=1, opttolerance=0.2`
- **tight** (high-fidelity): `alphamax=0.2, opttolerance=0.05`
- **smooth** (loose): `alphamax=1.3, opttolerance=0.8`

Each fed the *same binary mask* the app's own tracer consumed (`maskPreview`, read from the DOM), for a true apples-to-apples curve-fitting comparison isolated from any threshold/quantization difference. Regenerate with `node _system/potrace-spike/compare-curve-quality.mjs` (needs `npx serve . -l 4321` running); outputs land in `_system/potrace-spike/out-13/` (gitignored-by-convention, regenerate on demand, not committed).

## Results

### Hole-in-hole topology — #12's open caveat, now resolved

The TARGET/TRACK bullseye icons (outer ring → hole → center dot, 3 nesting levels) render **correctly at every tuning preset** — app, potrace-default, potrace-tight, potrace-smooth all produce the identical ring/gap/dot structure with no missing or inverted fills. The naive evenodd merge (concatenate potrace's per-color `d` data into one `<path fill-rule="evenodd">`, exactly what `cleanupSVG` does today) handles the third nesting level with no special-casing needed. This confirms #12's finding generalizes past single-hole topology — evenodd/nonzero parity computation doesn't care how many levels deep the nesting goes, only crossing parity at each point, which is invariant to potrace's winding convention for simple non-self-intersecting bitmap-traced contours. **Not assumed — verified by rendering all three depths and visually diffing.**

### Corner sharpness (`sharp-corners` case)

- **App (imagetracer, default settings)**: crisp, sharp arrowheads and notches, straight edges.
- **Potrace tight** (`alphamax=0.2`): visually matches or slightly *exceeds* app sharpness — arrow tips are pointed, edges straight, no rounding artifacts.
- **Potrace default** (`alphamax=1`, library default): noticeably blunts arrow tips and rounds concave notches — this is the setting #12 implicitly tested and found "indistinguishable," but that was against synthetic shapes with no sharp features to lose. On real angular content the library default is visibly softer than the app's current output.
- **Potrace smooth** (`alphamax=1.3`): rounds arrow points into blobby shapes — clearly worse, included as an extreme reference point, not a candidate setting.

### Fine detail (`fine-detail` case)

Same pattern, more pronounced: potrace-tight preserves crown finials (COMMAND icon) as sharp points, fist knuckle lines (BRUTE) stay crisp, CACHE's stack has clean scalloped bands — all comparable to or crisper than the app's current output. Potrace-default rounds crown points into blunt bumps, melts the fist's knuckle detail, and turns CACHE's scallops into bubbles. This is the clearest evidence in the spike that **potrace's own defaults are not a neutral proxy for "potrace's quality ceiling"** — #12's default-vs-default comparison would have been reasonably called a wash even if this exact same fine-detail content had been tested, because the *default* tuning genuinely is closer to app-equivalent, not better. The **tight** tuning is where a real quality win shows up.

Small text labels (under every icon in this crop) render as illegible blobs in **both** pipelines at this crop resolution (234×158px covering 6 icon+label pairs, so each label is roughly 10px tall pre-trace). This is a shared preprocessing/input-resolution limit, not a tracer differentiator — neither tracer can recover detail that the mask pipeline's threshold/despeckle stage already destroyed at this scale. Not a point in either direction.

### Path count / file size / timing (numbers, from `summary.json`)

| case | app: paths / bytes / ms | potrace-tight: merged bytes / subpaths / ms |
|---|---|---|
| sharp-corners | 16 / 2601 B / 238 ms | 3485 B / 16 / 1.8 ms |
| fine-detail | 32 / 4888 B / 220 ms | 6676 B / 33 / 2.2 ms |
| nested-holes | 29 / 4707 B / 212 ms | 6007 B / 29 / 2.2 ms |

- **Subpath/shape count matches closely** (16/16, 32/33, 29/29) — both tracers detect essentially the same set of distinct regions; potrace isn't fabricating or dropping shapes relative to the app.
- **Potrace's merged output runs 25–40% larger in bytes** across all three cases and all three presets (not just tight). This reproduces #12's exact caveat, not a new problem: the app's `compactPathData()` rounds/trims coordinate precision before the byte count is taken; potrace's raw `d` output here has had no equivalent rounding step applied. This spike didn't add that step (out of scope — it's an implementation detail, not a curve-quality question), so the byte-size gap is not evidence potrace produces heavier paths, just that the comparison still isn't apples-to-apples on precision. A real implementation needs this rounding pass regardless of which tuning preset is chosen.
- **Potrace's own trace call is 100–130× faster** (1.8–2.2ms vs 210–240ms), consistent with #12. As #12 noted, this isn't fully attributable to the curve-fitting stage — most of the app's time is its own mask preprocessing (Otsu threshold, despeckle, hole-fill, Scale2x/3x), untouched by this swap — but it's a real, reproduced side benefit.

## Recommendation: yes, there is a real quality win — conditional on tuning, not defaults

Unlike #12, which could reasonably conclude "a wash" from its evidence, this spike's evidence supports a real (if modest) fidelity improvement **specifically at a tight `alphamax`/`opttolerance` setting**, on the harder, more angular, more detailed content the app's actual users trace (icon/logo silhouettes with sharp corners and fine strokes, not smooth organic blobs). At potrace's own library defaults, #12's "indistinguishable" verdict holds up here too — it does not hold up at a tuned "tight" setting, where potrace visibly preserves more corner and fine-stroke detail than the app's current default output.

This is not a dramatic win — it will not read as "night and day" to a user — but it is a genuine, reproducible, non-manufactured difference, and it comes with the speed and (once rounding parity is added) likely-comparable file-size properties #12 already found favorable.

**This does not change #11's effort estimate or plan.** It confirms the slider-remapping work #11 already flagged as required is not optional polish — it's load-bearing for the quality win to actually materialize:

- `curve-fit` slider → today drives `qtres` linearly (`0.25 + curveFit * 0.9`); would need to drive `opttolerance`, and the useful range demonstrated here (`0.05` tight → `0.2` default-equivalent) is much narrower and non-linear-feeling than qtres's current range — needs tuning by eye against real logos, not a constant swap, exactly as #11 said.
- `corner-smoothing` slider → today drives a boolean `rightangleenhance` flag (on below a threshold, off above); would need to drive `alphamax` continuously instead. The demonstrated useful range here is roughly `0.2` (sharp) to `1.0` (library default, already visibly softer) to `1.3` (over-smooth) — a genuinely different, continuous control surface, not a threshold. This is a bigger remapping lift than `curve-fit`'s, worth flagging explicitly since #11's doc treated the two sliders as similar-effort; based on this spike they're not — `alphamax` is doing more perceptual work and has a narrower "good" band.
- `path-simplify` slider → unaffected by this spike (drives `ltres`/`roundcoords`, unrelated to potrace's corner/curve knobs); no new finding here.

**Suggested default if implemented**: something close to the `tight` preset tested here (`alphamax≈0.2, opttolerance≈0.05`), not potrace's library defaults — shipping potrace with its out-of-the-box defaults would be a lateral move at best per this spike's evidence, not the improvement the quality argument for doing this swap depends on.

## What's kept vs. cleaned up

- Kept: `_system/potrace-spike/compare-curve-quality.mjs` (new harness, extends `compare.mjs`'s patterns — reusable for whoever picks up the real implementation issue to re-verify against additional real logos before committing to a default tuning).
- Not committed: `_system/potrace-spike/out-13/` (generated SVGs/PNGs/summary — regenerate via the command above), `_screenshots/` (pre-existing gitignore, local test input, untouched by this session).
- `js/app.js`, `js/imagetracer.js`, `css/` — untouched. No app code was modified for this spike; all comparisons ran through the external harness against the real running app, per the session brief.

## Prior art check (CLAUDE.md requirement)

Ran `git log --oneline --grep="potrace" --grep="curve" --grep="alphamax" -i --all` before finalizing. Results: `a0dafe8` (#12 spike), `7955f3c` (#11 scoping) — both already read and treated as this spike's starting context, no other prior evaluation exists.
