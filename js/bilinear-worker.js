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

// Direction 3 from issue #32's findings: block-approximate despeckle that
// never allocates a BFS buffer at the fine (upsampled) resolution. Ported
// from _system/potrace-spike/compare-cheap-despeckle.mjs's cheapDespeckle().
function cheapDespeckle(fineMask, ow, oh, factor, w, h, despeckleNative, holeNative) {
  const coarse = new Uint8Array(w * h);
  const half = (factor * factor) / 2;
  for (let ny = 0; ny < h; ny++) {
    for (let nx = 0; nx < w; nx++) {
      let sum = 0;
      const fy0 = ny * factor;
      const fx0 = nx * factor;
      for (let dy = 0; dy < factor; dy++) {
        const row = (fy0 + dy) * ow + fx0;
        for (let dx = 0; dx < factor; dx++) sum += fineMask[row + dx];
      }
      coarse[ny * w + nx] = sum >= half ? 1 : 0;
    }
  }

  let cleaned = removeSmallComponents(coarse, w, h, despeckleNative);
  cleaned = fillSmallHoles(cleaned, w, h, holeNative);

  // Apply flip decisions back onto the fine mask in place — only blocks
  // whose coarse (native-resolution) vote changed get flattened; blocks
  // despeckle/hole-fill didn't touch keep their bilinear-derived sub-pixel
  // edge untouched. No extra fine-resolution buffer is allocated.
  const out = fineMask;
  for (let ny = 0; ny < h; ny++) {
    for (let nx = 0; nx < w; nx++) {
      const idx = ny * w + nx;
      if (coarse[idx] === cleaned[idx]) continue;
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
