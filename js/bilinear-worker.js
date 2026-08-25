// ── Bilinear-presupersample Worker (issue #34) ───────────────────────────
//
// Runs the pre-threshold bilinear-supersample pipeline off the main thread:
// bilinear-upsample a continuous grayscale luminance field by `factor`
// (always 2 in production — see js/app.js's BILINEAR_OUTPUT_CAP/#34 report),
// binarize at the upsampled resolution using the threshold the main thread
// already resolved, then despeckle/hole-fill via the cheap block-approximate
// algorithm validated in issue #32 (see
// _system/bilinear-presupersample-tracing-findings.md and
// _system/potrace-spike/compare-cheap-despeckle.mjs, which this is ported
// from): downsample the fine mask to native resolution via majority vote,
// run the SAME removeSmallComponents/fillSmallHoles used natively in
// js/app.js (copied here verbatim — keep these two functions byte-identical
// to app.js's if either ever changes) at native-resolution cost with
// native-unit maxArea thresholds (no factor² scaling needed, since this
// step never leaves native resolution), then flatten only the fine blocks
// whose native-resolution decision changed back onto the fine mask —
// blocks despeckle/hole-fill didn't touch keep their bilinear-derived
// sub-pixel edge exactly as-is. This is what lets a 4200x4200@2x trace
// survive instead of OOM-crashing (#32 findings: 1034ms vs. a crash for
// full high-res BFS despeckle at the same size).
//
// Moving this whole pipeline into a dedicated Worker (rather than running
// it on the main thread, as every other pipeline step in this app does)
// doesn't raise the memory ceiling by itself (#32 found dedicated Workers
// share the same renderer process/address space as their page in Chromium)
// but it does two things that matter: (1) keeps the UI thread responsive
// during the more expensive bilinear-supersample path, and (2) turns a
// same-thread `Array buffer allocation failed`/OOM into a catchable
// `worker.onerror`/rejected promise on the caller's side instead of a
// silent hang or a tab crash — js/app.js's runBilinearWorker() catches
// exactly this and falls back to tracing at native resolution.
//
// This is a plain (non-module) dedicated Worker on purpose — no
// `document`/DOM access is available in a Worker's global scope, so this
// file must stay fully self-contained. Do NOT importScripts('js/app.js')
// here; app.js assumes a DOM at parse time (document.getElementById calls
// run at the top level) and would throw immediately in a Worker.
//
// Message contract:
//   in:  { gray: Float64Array (transferred), w, h, factor, threshold,
//           invert, despeckleNative, holeNative }
//   out: { type: 'success', mask: Uint8Array (transferred), width, height }
//        { type: 'error', error: string }

// Copied verbatim from js/app.js's removeSmallComponents — see that file's
// version for the canonical copy if the two ever need to be reconciled.
function removeSmallComponents(mask, width, height, maxArea) {
  if (maxArea <= 0) return mask;
  const next = new Uint8Array(mask);
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start++) {
    if (!next[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const cells = [];

    while (head < tail) {
      const idx = queue[head++];
      cells.push(idx);
      const x = idx % width;
      const y = Math.floor(idx / width);

      if (x > 0) visitNeighbor(idx - 1);
      if (x < width - 1) visitNeighbor(idx + 1);
      if (y > 0) visitNeighbor(idx - width);
      if (y < height - 1) visitNeighbor(idx + width);
      if (x > 0 && y > 0) visitNeighbor(idx - width - 1);
      if (x < width - 1 && y > 0) visitNeighbor(idx - width + 1);
      if (x > 0 && y < height - 1) visitNeighbor(idx + width - 1);
      if (x < width - 1 && y < height - 1) visitNeighbor(idx + width + 1);
    }

    if (cells.length <= maxArea) {
      cells.forEach(idx => { next[idx] = 0; });
    }

    function visitNeighbor(nIdx) {
      if (!next[nIdx] || visited[nIdx]) return;
      visited[nIdx] = 1;
      queue[tail++] = nIdx;
    }
  }

  return next;
}

// Copied verbatim from js/app.js's fillSmallHoles — see that file's version
// for the canonical copy if the two ever need to be reconciled.
function fillSmallHoles(mask, width, height, maxArea) {
  if (maxArea <= 0) return mask;
  const next = new Uint8Array(mask);
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);

  for (let start = 0; start < next.length; start++) {
    if (next[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    let touchesBorder = false;
    const cells = [];

    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const idx = queue[head++];
      cells.push(idx);
      const x = idx % width;
      const y = Math.floor(idx / width);

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesBorder = true;
      }

      if (x > 0) visitNeighbor(idx - 1);
      if (x < width - 1) visitNeighbor(idx + 1);
      if (y > 0) visitNeighbor(idx - width);
      if (y < height - 1) visitNeighbor(idx + width);
    }

    if (!touchesBorder && cells.length <= maxArea) {
      cells.forEach(idx => { next[idx] = 1; });
    }

    function visitNeighbor(nIdx) {
      if (next[nIdx] || visited[nIdx]) return;
      visited[nIdx] = 1;
      queue[tail++] = nIdx;
    }
  }

  return next;
}

// Labels 8-connected foreground components in `mask` without mutating it —
// returns a same-length Int32Array of component id per cell (-1 for
// background) plus a Map of componentId -> area. Read-only sibling of
// removeSmallComponents, used by cheapDespeckle's spur pass below to size
// components without removing anything. Copied verbatim from
// _system/potrace-spike/sweep-despeckle-threshold.mjs's labelComponents —
// keep byte-identical if either ever changes.
function labelComponents(mask, width, height) {
  const labels = new Int32Array(mask.length).fill(-1);
  const areas = new Map();
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let nextId = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const id = nextId++;
    let head = 0;
    let tail = 0;
    let area = 0;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const idx = queue[head++];
      labels[idx] = id;
      area++;
      const x = idx % width;
      const y = Math.floor(idx / width);

      if (x > 0) visitNeighbor(idx - 1);
      if (x < width - 1) visitNeighbor(idx + 1);
      if (y > 0) visitNeighbor(idx - width);
      if (y < height - 1) visitNeighbor(idx + width);
      if (x > 0 && y > 0) visitNeighbor(idx - width - 1);
      if (x < width - 1 && y > 0) visitNeighbor(idx - width + 1);
      if (x > 0 && y < height - 1) visitNeighbor(idx + width - 1);
      if (x < width - 1 && y < height - 1) visitNeighbor(idx + width + 1);
    }

    areas.set(id, area);

    function visitNeighbor(nIdx) {
      if (!mask[nIdx] || visited[nIdx]) return;
      visited[nIdx] = 1;
      queue[tail++] = nIdx;
    }
  }

  return { labels, areas };
}

// Direction 3 from issue #32's findings: block-approximate despeckle that
// never allocates a BFS buffer at the fine (upsampled) resolution. Ported
// from _system/potrace-spike/compare-cheap-despeckle.mjs's cheapDespeckle().
//
// #35's original bug: cheapDespeckle's flat 50% block-majority vote left a
// stray dark fragment on aa-wordmark at 2x that full-BFS despeckle didn't
// have. Root cause (found via a debug pass comparing 50%-vote and
// 100%-vote masks block-by-block, see git history on the #35 branch): the
// stray fragment is a fully-saturated 1-native-block noise speck sitting
// ADJACENT to real letter geometry, bridged into that big legitimate shape
// by one weakly-covered (near-50%) block. The standard 50% vote's
// connected-component view never isolates it — it reads as structurally
// "attached" to a huge, obviously-not-small shape — so
// removeSmallComponents never gets a chance to evaluate it on its own, and
// its original fine pixels survive untouched.
//
// First fix attempt (requiring ALL factor x factor fine pixels foreground,
// sum === total) closed this gap by severing every weak/near-50% bridge
// indiscriminately — real or noise — which happened to fix aa-wordmark but
// was a correctness bug: it also severs a genuinely thin stroke from its
// own antialiased edge column, and removeSmallComponents then deletes the
// stroke's now-isolated (and now narrower) remainder if its area sits at
// or under despeckleNative. A synthetic hairline-tick regression test
// (_system/potrace-spike/sweep-despeckle-threshold.mjs's tickSurvival)
// confirmed this deletes legitimate ~despeckleNative-sized thin content.
// It was also separately found catastrophic at factor=4 (10x+ more paths)
// — moot today since factor is hardcoded to 2, but another sign the
// uniform-100%-vote rule was too blunt an instrument.
//
// The noise-speck and hairline-stroke cases are NOT distinguishable by
// connectivity shape alone — a block vote fundamentally can't tell "noise
// bridged onto real geometry" from "a real stroke bridged onto its own AA
// edge" purely from which blocks are connected. They ARE distinguishable
// by SIZE: an isolated noise speck's severed component is tiny (~1 native
// block); a real thin stroke's is comparable to despeckleNative itself
// (e.g. ~22 blocks for a ~22px-tall hairline at despeckleNative=24).
//
// So: run the standard 50%-vote despeckle/hole-fill pipeline UNCHANGED —
// exactly the pre-#35 shipped behavior, safe for thin strokes by
// construction — then run a SEPARATE, read-only sizing pass over a much
// stricter 100%-vote view (every fine pixel in the block must be
// foreground) via labelComponents, and strip only the blocks whose
// isolated 100%-vote component area is small (<= spurArea, capped at
// SPUR_AREA_CAP native blocks below) even though the standard pass kept
// them. This targets exactly the "tiny speck bridged onto a big shape"
// case the standard pass structurally can't see, without touching
// anything whose severed footprint is bigger than a couple of blocks
// (real strokes). spurArea is also capped by despeckleNative itself so
// the spur pass can never be MORE aggressive than the user's own
// despeckle setting, including despeckleNative=0 meaning "off" for both
// passes.
//
// Second-round fix (Gauge's pre-merge review of the size-only version
// above): area alone can't distinguish a boundary-attached noise speck
// (safe to zero) from the fully-saturated CORE of a small-but-legitimate
// shape whose AA/JPEG-softened rim keeps its whole perimeter at
// std-foreground (e.g. a small dot/period/serif tip) — that core is ALSO
// a tiny isolated 100%-vote component, entirely interior, surrounded on
// every side by std-foreground. Stripping it by size alone carves a
// permanent interior hole, since this pass runs AFTER fillSmallHoles and
// nothing re-fills afterward. Reproduced deterministically and confirmed
// via _system/potrace-spike/sweep-despeckle-threshold.mjs's
// small-dot-core case (a synthetic small solid disc with a tiny
// fully-saturated central core, sized exactly like a real small dot under
// this failure mode — see that function's header for why a JPEG-degraded
// real-image construction couldn't reproduce it reliably, same reason
// tickSurvival's header gives for the hairline-tick case).
//
// Fix: gate spur removal on BOUNDARY ADJACENCY, not size alone — a small
// strict-view component is only removed if it actually touches
// std-background somewhere (computed once per component via
// touchesStdBackground below). A boundary-attached noise speck always
// touches std-background on its far side (that's what makes it a spur,
// not part of the shape); a shape's interior core, being interior, never
// does. This is cheap (one more read-only pass over the native-resolution
// grid, same cost class as labelComponents) and requires no change to the
// aa-wordmark/hairline-tick behavior already validated above, since real
// spurs stay boundary-attached under this check.
//
// Validated via _system/potrace-spike/sweep-despeckle-threshold.mjs
// (decoupled-boundary-spur1..12 variants) at factor=2 (production's only
// value): exactly matches full-BFS despeckle's path count on aa-wordmark
// (fixing #35's original bug), stays bit-identical to the pre-#35 baseline
// on noisy-logo, keeps all 4 synthetic hairline ticks at 100% survival
// across despeckleNative in {4, 24, 48} and spurArea in {1,2,4,8,12},
// stays IDENTICAL to the pre-#35 baseline at factor=4 (no factor=4
// landmine) — AND, unlike the size-only version, leaves the small-dot-core
// case's interior core untouched (matches baseline-50pct's path count
// exactly) at spurArea=4 (production's SPUR_AREA_CAP, exercised directly —
// the fixture's core area is 1 block, comfortably inside the cap), while
// the size-only version measurably carves the hole (+1 path vs. baseline)
// at that same spurArea=4. Do not raise SPUR_AREA_CAP or drop the
// boundary-adjacency gate without re-running that sweep.
const SPUR_AREA_CAP = 4;
function cheapDespeckle(fineMask, ow, oh, factor, w, h, despeckleNative, holeNative) {
  const coarseStd = new Uint8Array(w * h);
  const coarseStrict = new Uint8Array(w * h);
  const total = factor * factor;
  const half = total / 2;
  for (let ny = 0; ny < h; ny++) {
    for (let nx = 0; nx < w; nx++) {
      let sum = 0;
      const fy0 = ny * factor;
      const fx0 = nx * factor;
      for (let dy = 0; dy < factor; dy++) {
        const row = (fy0 + dy) * ow + fx0;
        for (let dx = 0; dx < factor; dx++) sum += fineMask[row + dx];
      }
      const idx = ny * w + nx;
      coarseStd[idx] = sum >= half ? 1 : 0;
      coarseStrict[idx] = sum === total ? 1 : 0;
    }
  }

  // Standard pipeline — unchanged from pre-#35 shipped behavior.
  let cleaned = removeSmallComponents(coarseStd, w, h, despeckleNative);
  cleaned = fillSmallHoles(cleaned, w, h, holeNative);

  // Spur pass — strip only tiny isolated specks that (a) the standard
  // pass's bridging blindness let slip through attached to legitimate
  // shapes AND (b) actually touch std-background somewhere (excludes a
  // small shape's fully-interior core — see header).
  const spurArea = despeckleNative > 0 ? Math.min(despeckleNative, SPUR_AREA_CAP) : 0;
  if (spurArea > 0) {
    const { labels, areas } = labelComponents(coarseStrict, w, h);
    const touchesStdBackground = new Map();
    for (let ny = 0; ny < h; ny++) {
      for (let nx = 0; nx < w; nx++) {
        const idx = ny * w + nx;
        const id = labels[idx];
        if (id === -1 || touchesStdBackground.get(id)) continue;
        let touches = nx === 0 || ny === 0 || nx === w - 1 || ny === h - 1;
        for (let dy = -1; dy <= 1 && !touches; dy++) {
          for (let dx = -1; dx <= 1 && !touches; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ny2 = ny + dy;
            const nx2 = nx + dx;
            if (ny2 < 0 || ny2 >= h || nx2 < 0 || nx2 >= w) continue;
            if (cleaned[ny2 * w + nx2] === 0) touches = true;
          }
        }
        if (touches) touchesStdBackground.set(id, true);
        else if (!touchesStdBackground.has(id)) touchesStdBackground.set(id, false);
      }
    }
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] !== 1 || coarseStrict[i] !== 1) continue;
      const id = labels[i];
      if (areas.get(id) > spurArea) continue;
      if (!touchesStdBackground.get(id)) continue;
      cleaned[i] = 0;
    }
  }

  // Apply flip decisions back onto the fine mask in place — only blocks
  // whose coarse (native-resolution) decision changed get flattened;
  // blocks despeckle/hole-fill/spur-pass didn't touch keep their
  // bilinear-derived sub-pixel edge untouched. No extra fine-resolution
  // buffer is allocated.
  const out = fineMask;
  for (let ny = 0; ny < h; ny++) {
    for (let nx = 0; nx < w; nx++) {
      const idx = ny * w + nx;
      if (coarseStd[idx] === cleaned[idx]) continue;
      const v = cleaned[idx];
      const fy0 = ny * factor;
      const fx0 = nx * factor;
      for (let dy = 0; dy < factor; dy++) {
        const row = (fy0 + dy) * ow + fx0;
        for (let dx = 0; dx < factor; dx++) out[row + dx] = v;
      }
    }
  }
  return out;
}

// Half-pixel-center bilinear resample, ported from
// _system/potrace-spike/compare-bilinear-real-images.mjs /
// profile-perf-fix-candidates.mjs's runPipeline().
function bilinearUpsample(gray, w, h, factor) {
  const ow = w * factor;
  const oh = h * factor;
  const up = new Float64Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    let iy = (oy + 0.5) / factor - 0.5;
    if (iy < 0) iy = 0; else if (iy > h - 1) iy = h - 1;
    const y0 = Math.floor(iy);
    const y1 = Math.min(y0 + 1, h - 1);
    const fy = iy - y0;
    for (let ox = 0; ox < ow; ox++) {
      let ix = (ox + 0.5) / factor - 0.5;
      if (ix < 0) ix = 0; else if (ix > w - 1) ix = w - 1;
      const x0 = Math.floor(ix);
      const x1 = Math.min(x0 + 1, w - 1);
      const fx = ix - x0;
      const v00 = gray[y0 * w + x0];
      const v10 = gray[y0 * w + x1];
      const v01 = gray[y1 * w + x0];
      const v11 = gray[y1 * w + x1];
      const top = v00 * (1 - fx) + v10 * fx;
      const bot = v01 * (1 - fx) + v11 * fx;
      up[oy * ow + ox] = top * (1 - fy) + bot * fy;
    }
  }
  return { up, ow, oh };
}

self.onmessage = (e) => {
  const data = e.data || {};
  const { gray, w, h, factor, threshold, invert, despeckleNative, holeNative } = data;
  try {
    const { up, ow, oh } = bilinearUpsample(gray, w, h, factor);

    const mask = new Uint8Array(ow * oh);
    for (let i = 0; i < up.length; i++) {
      let dark = up[i] < threshold;
      if (invert) dark = !dark;
      mask[i] = dark ? 1 : 0;
    }

    const finalMask = cheapDespeckle(mask, ow, oh, factor, w, h, despeckleNative, holeNative);

    self.postMessage(
      { type: 'success', mask: finalMask, width: ow, height: oh },
      [finalMask.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
};
