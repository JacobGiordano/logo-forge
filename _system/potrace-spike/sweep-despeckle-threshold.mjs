// Iteration harness for issue #35: sweep majority-vote threshold variants for
// cheapDespeckle (js/bilinear-worker.js, shipped in #34) against the
// real-image quality methodology from compare-cheap-despeckle.mjs's Part B
// (same two cases: noisy-logo, aa-wordmark -- the only cases that harness
// defines, per #35's ask to check "other test cases... if any exist").
//
// #35's background: cheapDespeckle's flat 50% block majority vote left one
// stray dark fragment path on aa-wordmark at 2x that exact per-pixel BFS
// despeckle didn't have (findings doc's predicted cause: a speck/thin
// feature straddling a native-pixel block boundary can fail to trigger the
// vote in either adjacent block, so it's invisible to despeckle and its
// original fine-resolution pixels survive untouched).
//
// This sweep tested three directions across two rounds. Round 1 (pre-review)
// tried (1) a uniform non-50% vote fraction, (2) an asymmetric threshold
// (stricter on despeckle's removal side, standard 50% on hole-fill's side --
// see the `asymmetric` variant kind below). Counter to the findings doc's
// initial guess, LOWERING the removal-side threshold (easier to register as
// foreground) made both cases measurably worse -- it merges isolated
// noise/AA-edge pixels into larger connected coarse components that exceed
// the despeckle area threshold and survive, growing fragment/path counts
// (uniform-any-pixel/uniform-25pct). RAISING it to 100% (every fine pixel in
// a block must be foreground -- an AND-downsample, not a majority vote) DID
// close the aa-wordmark gap exactly, at factor=2, and was shipped in commit
// a4e47c9 -- but a Gauge pre-merge review caught a real correctness bug: it
// deletes legitimate thin content (hairline strokes/fine serifs) whose
// coarse footprint sits near despeckleNative, because it severs EVERY
// weakly-covered (~50%) bridge indiscriminately, real stroke-to-AA-edge or
// noise-to-real-geometry alike. See tickSurvival()'s header comment for the
// synthetic regression case that caught this (uniform-75pct/90pct/100pct and
// asym-remove-75pct/90pct/100pct all fail it identically, since they all key
// removal off the STRICT view's severed component size).
//
// Round 2 (post-review) adds the `decoupled` variant kind: run the standard
// 50%-vote pipeline UNCHANGED (tick-safe by construction, since it's exactly
// the pre-#35 baseline) and layer a SEPARATE small-area-only removal pass on
// top, using the 100%-vote view's connected components (read-only, via
// labelComponents) purely to size candidates -- strip a block only if it's
// foreground in the standard pass's output AND its isolated 100%-vote
// component is tiny (<= spurArea). This is what actually satisfies "small
// under both a strict and a lenient view": aa-wordmark's stray fragment is a
// ~1-block noise speck under the strict view (small under both), while the
// hairline ticks' severed core is ~22 blocks (small under the strict view
// alone, but NOT small under the lenient/standard view, where it merges with
// its AA edge into a ~44-block component) -- so decoupled removes the former
// and correctly leaves the latter alone. spurArea in {1,2,4,8,12} all
// produced identical results in this sweep (exact match on aa-wordmark,
// bit-identical noisy-logo, 100% tick survival, across despeckleNative in
// {4, 24, 48}); spur4 was ported to production as SPUR_AREA_CAP (see
// js/bilinear-worker.js's cheapDespeckle) -- comfortably above real noise
// specks (~1 block) and comfortably below real thin strokes (~20+ blocks at
// default despeckleNative=24), with headroom either direction.
//
// Requires a dev server already running (BASE_URL below must match).
// Optional env vars: DESPECKLE_NATIVE, HOLE_NATIVE (default 24/12, matching
// index.html's slider defaults), DUMP_PNG=1 (writes F2 mask PNGs to
// out-35-visual/, gitignored, for a manual visual erosion/quality check).
//
// Usage: node _system/potrace-spike/sweep-despeckle-threshold.mjs

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'http://localhost:4321';
const WORK_SIZE = 240;
const GT_SIZE = 960;
const TIGHT = { alphamax: 0.35, opttolerance: 0.05 };
const PRODUCTION_LIKE = {
  turnpolicy: 4, opticurve: 1, pathonly: false,
  extractcolors: true, posterizelevel: 2, posterizationalgorithm: 0,
  ...TIGHT,
};
const DESPECKLE_NATIVE = process.env.DESPECKLE_NATIVE ? +process.env.DESPECKLE_NATIVE : 24;
const HOLE_NATIVE = process.env.HOLE_NATIVE ? +process.env.HOLE_NATIVE : 12;

// ── Shared JS injected into page.evaluate blocks ────────────────────────
// removeSmallComponents/fillSmallHoles copied verbatim from js/app.js
// (same copies as compare-cheap-despeckle.mjs). cheapDespeckle here takes an
// extra `variant` param selecting the vote-threshold strategy under test.
const SHARED_FNS = `
function computeOtsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, weightB = 0, maxVariance = -1, threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > maxVariance) { maxVariance = variance; threshold = t; }
  }
  return Math.max(1, Math.min(254, threshold));
}
function removeSmallComponents(mask, width, height, maxArea) {
  if (maxArea <= 0) return mask;
  const next = new Uint8Array(mask);
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!next[start] || visited[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start; visited[start] = 1;
    const cells = [];
    while (head < tail) {
      const idx = queue[head++];
      cells.push(idx);
      const x = idx % width, y = Math.floor(idx / width);
      const push = (nIdx) => { if (next[nIdx] && !visited[nIdx]) { visited[nIdx] = 1; queue[tail++] = nIdx; } };
      if (x > 0) push(idx - 1);
      if (x < width - 1) push(idx + 1);
      if (y > 0) push(idx - width);
      if (y < height - 1) push(idx + width);
      if (x > 0 && y > 0) push(idx - width - 1);
      if (x < width - 1 && y > 0) push(idx - width + 1);
      if (x > 0 && y < height - 1) push(idx + width - 1);
      if (x < width - 1 && y < height - 1) push(idx + width + 1);
    }
    if (cells.length <= maxArea) cells.forEach(idx => { next[idx] = 0; });
  }
  return next;
}
// Labels 8-connected foreground components in \`mask\` and returns a same-
// length Int32Array of component-id per cell (-1 for background) plus a
// Map of componentId -> area. Used by the 'decoupled' variant to size a
// component WITHOUT removing anything (removeSmallComponents both finds
// and mutates in one pass; here we need sizes only, read-only).
function labelComponents(mask, width, height) {
  const labels = new Int32Array(mask.length).fill(-1);
  const areas = new Map();
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let nextId = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const id = nextId++;
    let head = 0, tail = 0, area = 0;
    queue[tail++] = start; visited[start] = 1;
    while (head < tail) {
      const idx = queue[head++];
      labels[idx] = id;
      area++;
      const x = idx % width, y = Math.floor(idx / width);
      const push = (nIdx) => { if (mask[nIdx] && !visited[nIdx]) { visited[nIdx] = 1; queue[tail++] = nIdx; } };
      if (x > 0) push(idx - 1);
      if (x < width - 1) push(idx + 1);
      if (y > 0) push(idx - width);
      if (y < height - 1) push(idx + width);
      if (x > 0 && y > 0) push(idx - width - 1);
      if (x < width - 1 && y > 0) push(idx - width + 1);
      if (x > 0 && y < height - 1) push(idx + width - 1);
      if (x < width - 1 && y < height - 1) push(idx + width + 1);
    }
    areas.set(id, area);
  }
  return { labels, areas };
}
function fillSmallHoles(mask, width, height, maxArea) {
  if (maxArea <= 0) return mask;
  const next = new Uint8Array(mask);
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < next.length; start++) {
    if (next[start] || visited[start]) continue;
    let head = 0, tail = 0, touchesBorder = false;
    const cells = [];
    queue[tail++] = start; visited[start] = 1;
    while (head < tail) {
      const idx = queue[head++];
      cells.push(idx);
      const x = idx % width, y = Math.floor(idx / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      const push = (nIdx) => { if (!next[nIdx] && !visited[nIdx]) { visited[nIdx] = 1; queue[tail++] = nIdx; } };
      if (x > 0) push(idx - 1);
      if (x < width - 1) push(idx + 1);
      if (y > 0) push(idx - width);
      if (y < height - 1) push(idx + width);
    }
    if (!touchesBorder && cells.length <= maxArea) cells.forEach(idx => { next[idx] = 1; });
  }
  return next;
}

// variant param:
//   { kind: 'uniform', frac: 0..1 }   -- single vote fraction for both sides
//   { kind: 'asymmetric', removeFrac: 0..1 }
//       -- despeckle/removal side votes foreground at removeFrac (stricter,
//          typically lower than 0.5, so specks straddling a block boundary
//          register as foreground and become visible to removeSmallComponents);
//          hole-fill side still operates from the STANDARD 50% vote, patched
//          only where despeckle explicitly removed something. This keeps
//          hole-fill's behavior identical to today's shipped version except
//          where despeckle's stricter pass found something to remove.
//   { kind: 'decoupled', spurArea: N }
//       -- Gauge's #35-review-suggested "small under BOTH a strict AND a
//          lenient view" rule, actually implemented (not just an existing
//          variant relabeled). Root-caused via _system/potrace-spike's
//          debug pass on aa-wordmark: the stray fragment isn't an
//          invisible-below-50%-everywhere speck (the findings-doc's
//          original guess) -- it's a fully-saturated 1-native-block noise
//          speck that sits ADJACENT to real letter geometry and is bridged
//          into that big legitimate component by one weakly-covered (near
//          50%) block, so the STANDARD 50% view's connected-component
//          analysis never isolates it (it's structurally "attached" to a
//          huge, clearly-not-small shape) and removeSmallComponents never
//          gets a chance to evaluate it on its own. The 100pct-vote fix
//          "worked" only because it happens to sever that same weak bridge
//          for EVERY thin feature, real or noise, indiscriminately --
//          which is exactly what deletes the hairline ticks (a real stroke
//          bridged into its own antialiased edge column the same way).
//          A block-vote-based coarse mask fundamentally cannot tell "a
//          couple of blocks of noise bridged onto real geometry" from "a
//          thin real stroke bridged onto its own AA edge" by connectivity
//          shape alone -- both sever into an isolated small strict
//          component when the bridge is cut. The two ARE distinguishable
//          by SIZE: the noise speck's isolated strict component is ~1
//          block; the tick's is ~22 (near despeckleNative itself). So:
//          run the standard 50%-vote pipeline UNCHANGED (this is exactly
//          today's shipped behavior, tick-safe by construction) as the
//          baseline, then run a SEPARATE, much smaller-area removal pass
//          using the 100%-vote's connected components (labeled, not
//          mutated) to catch only genuinely tiny attached specks
//          (isolated strict-component area <= spurArea, default small --
//          e.g. 2-4 blocks) that the standard pass's bridging blindness
//          let slip through attached to legitimate shapes. Anything whose
//          isolated strict-component area is above spurArea (a real thin
//          stroke) is left exactly as the standard pass decided.
function cheapDespeckle(fineMask, ow, oh, factor, w, h, despeckleNative, holeNative, variant) {
  const total = factor * factor;
  const half = total / 2;

  if (variant.kind === 'uniform') {
    const thresh = Math.max(1, Math.ceil(total * variant.frac));
    const coarse = new Uint8Array(w * h);
    for (let ny = 0; ny < h; ny++) {
      for (let nx = 0; nx < w; nx++) {
        let sum = 0;
        const fy0 = ny * factor, fx0 = nx * factor;
        for (let dy = 0; dy < factor; dy++) {
          const row = (fy0 + dy) * ow + fx0;
          for (let dx = 0; dx < factor; dx++) sum += fineMask[row + dx];
        }
        coarse[ny * w + nx] = sum >= thresh ? 1 : 0;
      }
    }
    let cleaned = removeSmallComponents(coarse, w, h, despeckleNative);
    cleaned = fillSmallHoles(cleaned, w, h, holeNative);
    const out = fineMask;
    let blocksChanged = 0;
    for (let ny = 0; ny < h; ny++) {
      for (let nx = 0; nx < w; nx++) {
        const idx = ny * w + nx;
        if (coarse[idx] === cleaned[idx]) continue;
        blocksChanged++;
        const v = cleaned[idx];
        const fy0 = ny * factor, fx0 = nx * factor;
        for (let dy = 0; dy < factor; dy++) {
          const row = (fy0 + dy) * ow + fx0;
          for (let dx = 0; dx < factor; dx++) out[row + dx] = v;
        }
      }
    }
    return { mask: out, blocksChanged, totalBlocks: w * h };
  }

  if (variant.kind === 'decoupled') {
    const coarseStd = new Uint8Array(w * h);
    const coarseStrict = new Uint8Array(w * h);
    for (let ny = 0; ny < h; ny++) {
      for (let nx = 0; nx < w; nx++) {
        let sum = 0;
        const fy0 = ny * factor, fx0 = nx * factor;
        for (let dy = 0; dy < factor; dy++) {
          const row = (fy0 + dy) * ow + fx0;
          for (let dx = 0; dx < factor; dx++) sum += fineMask[row + dx];
        }
        const idx = ny * w + nx;
        coarseStd[idx] = sum >= half ? 1 : 0;
        coarseStrict[idx] = sum === total ? 1 : 0;
      }
    }
    // Standard pipeline, unchanged -- this IS today's shipped behavior.
    const cleanedStd = fillSmallHoles(removeSmallComponents(coarseStd, w, h, despeckleNative), w, h, holeNative);

    // Read-only sizing pass over the strict (100%) view -- find isolated
    // strict components small enough to be spurs, and strip only those
    // from the standard pipeline's result.
    const { labels, areas } = labelComponents(coarseStrict, w, h);

    // Boundary-adjacency gate (Gauge #35-review-round-2 fix): a small
    // strict component is only a genuine "spur attached to background on
    // its far side" if it actually touches std-background somewhere.
    // Without this, the spur pass can't tell that apart from the
    // fully-saturated CORE of a small-but-legitimate shape (e.g. a dot
    // whose AA/JPEG-softened rim keeps its whole perimeter at std=1, so
    // its tiny 100%-saturated center is surrounded on every side by
    // std-foreground) -- stripping that core carves a permanent interior
    // hole, since this pass runs AFTER fillSmallHoles and nothing re-fills
    // afterward. Computed once per component id (image-border cells count
    // as touching background too, since off-canvas is implicitly empty).
    const touchesBackground = new Map();
    if (variant.requireBoundaryTouch) {
      for (let ny = 0; ny < h; ny++) {
        for (let nx = 0; nx < w; nx++) {
          const idx = ny * w + nx;
          const id = labels[idx];
          if (id === -1 || touchesBackground.get(id)) continue;
          let touches = nx === 0 || ny === 0 || nx === w - 1 || ny === h - 1;
          for (let dy = -1; dy <= 1 && !touches; dy++) {
            for (let dx = -1; dx <= 1 && !touches; dx++) {
              if (dx === 0 && dy === 0) continue;
              const ny2 = ny + dy, nx2 = nx + dx;
              if (ny2 < 0 || ny2 >= h || nx2 < 0 || nx2 >= w) continue;
              if (cleanedStd[ny2 * w + nx2] === 0) touches = true;
            }
          }
          if (touches) touchesBackground.set(id, true);
          else if (!touchesBackground.has(id)) touchesBackground.set(id, false);
        }
      }
    }

    const final = new Uint8Array(cleanedStd);
    let spurBlocksRemoved = 0;
    for (let i = 0; i < final.length; i++) {
      if (final[i] !== 1 || coarseStrict[i] !== 1) continue;
      const id = labels[i];
      const area = areas.get(id);
      if (area > variant.spurArea) continue;
      if (variant.requireBoundaryTouch && !touchesBackground.get(id)) continue;
      final[i] = 0;
      spurBlocksRemoved++;
    }

    const out = fineMask;
    let blocksChanged = 0;
    for (let ny = 0; ny < h; ny++) {
      for (let nx = 0; nx < w; nx++) {
        const idx = ny * w + nx;
        if (coarseStd[idx] === final[idx]) continue;
        blocksChanged++;
        const v = final[idx];
        const fy0 = ny * factor, fx0 = nx * factor;
        for (let dy = 0; dy < factor; dy++) {
          const row = (fy0 + dy) * ow + fx0;
          for (let dx = 0; dx < factor; dx++) out[row + dx] = v;
        }
      }
    }
    return { mask: out, blocksChanged, totalBlocks: w * h, spurBlocksRemoved };
  }

  // asymmetric
  const removeThresh = Math.max(1, Math.ceil(total * variant.removeFrac));
  const coarseStd = new Uint8Array(w * h);
  const coarseStrict = new Uint8Array(w * h);
  for (let ny = 0; ny < h; ny++) {
    for (let nx = 0; nx < w; nx++) {
      let sum = 0;
      const fy0 = ny * factor, fx0 = nx * factor;
      for (let dy = 0; dy < factor; dy++) {
        const row = (fy0 + dy) * ow + fx0;
        for (let dx = 0; dx < factor; dx++) sum += fineMask[row + dx];
      }
      const idx = ny * w + nx;
      coarseStd[idx] = sum >= half ? 1 : 0;
      coarseStrict[idx] = sum >= removeThresh ? 1 : 0;
    }
  }
  const removedByDespeckle = removeSmallComponents(coarseStrict, w, h, despeckleNative);
  const afterDespeckle = new Uint8Array(w * h);
  for (let i = 0; i < afterDespeckle.length; i++) {
    afterDespeckle[i] = (coarseStrict[i] === 1 && removedByDespeckle[i] === 0) ? 0 : coarseStd[i];
  }
  const cleaned = fillSmallHoles(afterDespeckle, w, h, holeNative);
  const out = fineMask;
  let blocksChanged = 0;
  for (let ny = 0; ny < h; ny++) {
    for (let nx = 0; nx < w; nx++) {
      const idx = ny * w + nx;
      if (coarseStd[idx] === cleaned[idx]) continue;
      blocksChanged++;
      const v = cleaned[idx];
      const fy0 = ny * factor, fx0 = nx * factor;
      for (let dy = 0; dy < factor; dy++) {
        const row = (fy0 + dy) * ow + fx0;
        for (let dx = 0; dx < factor; dx++) out[row + dx] = v;
      }
    }
  }
  return { mask: out, blocksChanged, totalBlocks: w * h };
}
`;

async function loadPotrace(page) {
  await page.evaluate(async () => {
    if (window.__potraceMod) return;
    const mod = await import('/js/potrace-wasm.js');
    await mod.init();
    window.__potraceMod = mod;
  });
}

async function makeDegradedSource(page, kind, size) {
  return page.evaluate(
    ({ kind, size }) => {
      function drawClean(ctx, s) {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, s, s);
        ctx.fillStyle = '#000';
        if (kind === 'noisy-logo') {
          ctx.beginPath();
          const cx = s / 2, cy = s / 2, rOuter = s * 0.42, rInner = s * 0.17, spikes = 6;
          for (let i = 0; i < spikes * 2; i++) {
            const r = i % 2 === 0 ? rOuter : rInner;
            const a = (Math.PI / spikes) * i - Math.PI / 2;
            const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill();
        } else if (kind === 'aa-wordmark') {
          ctx.font = `bold ${Math.round(s * 0.32)}px Arial, sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillText('LOGO', s / 2, s * 0.38);
          ctx.beginPath();
          ctx.arc(s * 0.5, s * 0.72, s * 0.14, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const clean = document.createElement('canvas');
      clean.width = size; clean.height = size;
      drawClean(clean.getContext('2d'), size);
      const jpegUrl = clean.toDataURL('image/jpeg', 0.35);
      return { jpegUrl };
    },
    { kind, size }
  );
}

async function jpegToNoisyPng(page, jpegUrl, size) {
  return page.evaluate(
    async ({ jpegUrl, size }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = jpegUrl; });
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      const id = ctx.getImageData(0, 0, size, size);
      let seed = 12345;
      function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
      for (let i = 0; i < id.data.length; i += 4) {
        if (rnd() < 0.008) {
          const v = rnd() < 0.5 ? 0 : 255;
          id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
        }
      }
      ctx.putImageData(id, 0, 0);
      return c.toDataURL('image/png');
    },
    { jpegUrl, size }
  );
}

async function buildMask(page, dataUrl, factor, variant) {
  return page.evaluate(
    async ({ dataUrl, factor, variant, despeckleNative, holeNative, sharedFns }) => {
      const build = new Function(sharedFns + '; return { computeOtsuThreshold, removeSmallComponents, fillSmallHoles, cheapDespeckle };');
      const { computeOtsuThreshold, cheapDespeckle } = build();

      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const src = ctx.getImageData(0, 0, w, h);

      const lum = new Float64Array(w * h);
      for (let i = 0, px = 0; i < src.data.length; i += 4, px++) {
        const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2], a = src.data[i + 3] / 255;
        lum[px] = (r * 0.299 + g * 0.587 + b * 0.114) * a + 255 * (1 - a);
      }

      const ow = w * factor, oh = h * factor;
      const up = new Float64Array(ow * oh);
      for (let oy = 0; oy < oh; oy++) {
        let iy = (oy + 0.5) / factor - 0.5;
        if (iy < 0) iy = 0; if (iy > h - 1) iy = h - 1;
        const y0 = Math.floor(iy), y1 = Math.min(y0 + 1, h - 1), fy = iy - y0;
        for (let ox = 0; ox < ow; ox++) {
          let ix = (ox + 0.5) / factor - 0.5;
          if (ix < 0) ix = 0; if (ix > w - 1) ix = w - 1;
          const x0 = Math.floor(ix), x1 = Math.min(x0 + 1, w - 1), fx = ix - x0;
          const v00 = lum[y0 * w + x0], v10 = lum[y0 * w + x1];
          const v01 = lum[y1 * w + x0], v11 = lum[y1 * w + x1];
          const top = v00 * (1 - fx) + v10 * fx;
          const bot = v01 * (1 - fx) + v11 * fx;
          up[oy * ow + ox] = top * (1 - fy) + bot * fy;
        }
      }

      const hist = new Uint32Array(256);
      for (let i = 0; i < up.length; i++) hist[Math.max(0, Math.min(255, Math.round(up[i])))]++;
      const threshold = computeOtsuThreshold(hist, up.length);

      let mask = new Uint8Array(ow * oh);
      for (let i = 0; i < up.length; i++) mask[i] = up[i] < threshold ? 1 : 0;

      const r = cheapDespeckle(mask, ow, oh, factor, w, h, despeckleNative, holeNative, variant);
      mask = r.mask;
      const despeckleInfo = { blocksChanged: r.blocksChanged, totalBlocks: r.totalBlocks };

      const maskImg = new Uint8ClampedArray(ow * oh * 4);
      for (let i = 0; i < mask.length; i++) {
        const v = mask[i] ? 0 : 255;
        const idx = i * 4;
        maskImg[idx] = v; maskImg[idx + 1] = v; maskImg[idx + 2] = v; maskImg[idx + 3] = 255;
      }
      const outCanvas = document.createElement('canvas');
      outCanvas.width = ow; outCanvas.height = oh;
      outCanvas.getContext('2d').putImageData(new ImageData(maskImg, ow, oh), 0, 0);
      return { dataUrl: outCanvas.toDataURL('image/png'), width: ow, height: oh, threshold, despeckleInfo };
    },
    { dataUrl, factor, variant, despeckleNative: DESPECKLE_NATIVE, holeNative: HOLE_NATIVE, sharedFns: SHARED_FNS }
  );
}

// small-dot-core regression case (Gauge #35-review-round-2): a small but
// clearly-legitimate filled blob whose fully-saturated (100%-vote)
// interior CORE is tiny (<= a spur-sized area) while its overall std
// (50%-vote) footprint is large and entirely std-foreground around that
// core -- the exact "interior of a legitimate shape" case an unguarded
// spur pass can't tell apart from a real boundary-attached speck.
//
// First attempt at this case drew a real filled circle/rounded-rect on a
// canvas and JPEG-degraded it (matching noisy-logo/aa-wordmark's
// methodology, and Gauge's suggested construction) -- that MISFIRED for
// the same root reason tickSurvival's header documents for canvas/Otsu
// constructions: a single global Otsu threshold produces a CRISP
// fine-resolution binary boundary, so a native block only fails the
// 100%-vote test if that crisp boundary curve actually passes through it.
// That failure band's block count scales with the shape's PERIMETER, not
// blur/JPEG softening strength (measured empirically: a 7px-radius circle
// lost only ~12 of ~154 blocks to the 100%-vote rim regardless of a 1.5-3px
// canvas blur pre-pass) -- so for any shape round/fat enough for its std
// area to clear despeckleNative=24, its strict-view core stays far above
// SPUR_AREA_CAP; shrinking it further requires shrinking the whole shape
// below despeckleNative first. Reproducing Gauge's exact vote pattern
// organically isn't reliable here, same conclusion tickSurvival already
// reached for the hairline-tick case.
//
// This version builds the fine mask directly instead (tickSurvival's
// proven approach): a filled native-radius-R disc where EVERY block
// (not just an edge rim) is set to exactly the classic 50%-vote fringe
// level (sum === half) -- so the std view sees one big, uniformly
// std-foreground disc (area ~= pi*R^2, safely above despeckleNative) --
// except for a small coreRadius nucleus at dead center, which is set
// fully saturated (sum === total) -- an isolated strict-view component of
// area <= spurArea, surrounded on every side by std-foreground, never
// touching std-background. Deterministic, reproducible, exactly matches
// Gauge's described failure geometry without fighting Otsu.
//
// Runs BOTH cheapDespeckle(variant) and a full BFS despeckle/hole-fill
// (native removeSmallComponents/fillSmallHoles run directly at fine
// resolution, maxArea scaled by factor^2 -- no block-vote approximation
// at all, so it can't carve a spurious hole) on separate copies of the
// SAME input mask, renders both to PNG, and returns both dataUrls for the
// caller to run through potrace and compare pathCount -- same instrument
// used for the aa-wordmark case. A hole the spur pass carves shows up as
// an extra rendered path/subpath vs. the full-BFS reference.
async function coreHoleCheck(page, factor, variant, despeckleNative, holeNative) {
  return page.evaluate(
    ({ factor, variant, despeckleNative, holeNative, sharedFns }) => {
      const build = new Function(sharedFns + '; return { removeSmallComponents, fillSmallHoles, cheapDespeckle };');
      const { removeSmallComponents, fillSmallHoles, cheapDespeckle } = build();

      const w = 240, h = 240; // native size, matches WORK_SIZE
      const ow = w * factor, oh = h * factor;
      const total = factor * factor;

      const R = 6;             // disc radius, native px -- std area ~pi*36=113, >> despeckleNative=24
      const coreRadius = 1;    // fully-saturated nucleus radius -- area <= SPUR_AREA_CAP(4)
      const cx = Math.floor(w / 2), cy = Math.floor(h / 2);

      function setBlockFull(nx, ny) {
        const fy0 = ny * factor, fx0 = nx * factor;
        for (let dy = 0; dy < factor; dy++) {
          const row = (fy0 + dy) * ow + fx0;
          for (let dx = 0; dx < factor; dx++) fineMask[row + dx] = 1;
        }
      }
      // Fully saturated except the single fine sub-pixel at the block's
      // OUTWARD corner (farthest from disc center) -- leaves the moat one
      // fine pixel short of saturation (breaking strict registration)
      // while the missing pixel's position is chosen coherently with the
      // disc's true boundary direction, instead of an arbitrary fixed
      // corner. This keeps the moat's un-flattened texture reading as a
      // smooth, marginally eroded circular edge instead of jagged noise.
      function setBlockMoat(nx, ny) {
        setBlockFull(nx, ny);
        const fy0 = ny * factor, fx0 = nx * factor;
        const dx = nx >= cx ? factor - 1 : 0;
        const dy = ny >= cy ? factor - 1 : 0;
        fineMask[(fy0 + dy) * ow + (fx0 + dx)] = 0;
      }

      const fineMask = new Uint8Array(ow * oh);
      let stdArea = 0, coreArea = 0;
      const nucleus = new Set();
      for (let ny = cy - R - 1; ny <= cy + R + 1; ny++) {
        for (let nx = cx - R - 1; nx <= cx + R + 1; nx++) {
          if (Math.hypot(nx - cx, ny - cy) <= coreRadius) { nucleus.add(ny * w + nx); coreArea++; }
        }
      }
      // Moat = every 8-neighbor of every nucleus block that isn't itself
      // nucleus -- an explicit morphological dilation, not a
      // distance-threshold ring. A distance-threshold ring (an earlier
      // version of this construction) left gaps: a nucleus block near its
      // own radius edge can be 8-adjacent to a bulk block just outside the
      // ring's radius cutoff, silently re-merging the nucleus into the
      // bulk's strict component and making the whole test vacuous (the
      // spur pass never saw an isolated nucleus to act on at all).
      // Dilation guarantees EVERY neighbor of EVERY nucleus block is
      // either nucleus or explicit moat, never an accidental bulk leak.
      const moat = new Set();
      for (const idx of nucleus) {
        const nx = idx % w, ny = Math.floor(idx / w);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const idx2 = (ny + dy) * w + (nx + dx);
            if (!nucleus.has(idx2)) moat.add(idx2);
          }
        }
      }
      for (let ny = cy - R - 2; ny <= cy + R + 2; ny++) {
        for (let nx = cx - R - 2; nx <= cx + R + 2; nx++) {
          const idx = ny * w + nx;
          const inDisc = Math.hypot(nx - cx, ny - cy) <= R;
          if (nucleus.has(idx)) { setBlockFull(nx, ny); stdArea++; }
          else if (moat.has(idx)) { setBlockMoat(nx, ny); stdArea++; }
          else if (inDisc) { setBlockFull(nx, ny); stdArea++; }
        }
      }

      const fullMask = new Uint8Array(fineMask); // full-BFS reference input, untouched by cheapDespeckle
      const cheapOut = new Uint8Array(fineMask); // cheapDespeckle mutates in place

      const cheapResult = cheapDespeckle(cheapOut, ow, oh, factor, w, h, despeckleNative, holeNative, variant);

      const factorAreaScale = total;
      let full = removeSmallComponents(fullMask, ow, oh, despeckleNative * factorAreaScale);
      full = fillSmallHoles(full, ow, oh, holeNative * factorAreaScale);

      function toDataUrl(mask) {
        const img = new Uint8ClampedArray(ow * oh * 4);
        for (let i = 0; i < mask.length; i++) {
          const v = mask[i] ? 0 : 255;
          const idx = i * 4;
          img[idx] = v; img[idx + 1] = v; img[idx + 2] = v; img[idx + 3] = 255;
        }
        const c = document.createElement('canvas');
        c.width = ow; c.height = oh;
        c.getContext('2d').putImageData(new ImageData(img, ow, oh), 0, 0);
        return c.toDataURL('image/png');
      }

      return {
        variantDataUrl: toDataUrl(cheapOut),
        fullDataUrl: toDataUrl(full),
        width: ow,
        height: oh,
        blocksChanged: cheapResult && cheapResult.blocksChanged,
        spurBlocksRemoved: cheapResult && cheapResult.spurBlocksRemoved,
        stdArea,
        coreArea,
      };
    },
    { factor, variant, despeckleNative, holeNative, sharedFns: SHARED_FNS }
  );
}

// Thin-stroke (hairline-tick) regression case added after Gauge's #35
// pre-merge review: uniform-100pct fixes aa-wordmark's stray fragment but
// deletes legitimate thin content whose coarse footprint sits near
// despeckleNative.
//
// First attempt at this case (see git history on this branch) drew real
// canvas lines and ran them through the actual bilinear+Otsu pipeline --
// that MISFIRED: Otsu's threshold, computed on the real histogram,
// resolved the antialiased edge to a single fully-saturated native column
// with ZERO contribution from the adjacent column (not the ~50/50 split a
// canvas AA line usually produces), so the tick's baseline (50%) coarse
// component was ALREADY only ~22 blocks -- already at/under
// despeckleNative=24 and deleted by baseline too. That doesn't reproduce
// Gauge's regression (baseline preserves, 100% deletes); it just shows a
// separately-known "content below the despeckle threshold gets removed"
// case that both rules agree on. Canvas/Otsu numerical behavior isn't
// reliable enough to hit the specific vote pattern under test.
//
// This version constructs the fine mask directly instead, with exact
// control per native block -- deterministic, reproducible, no
// canvas/Otsu involved. Each of 4 ticks is a tickLen-native-pixel-long
// vertical stroke straddling two adjacent native columns: the "core"
// column is FULLY saturated every row (sum === factor*factor, matching a
// stroke whose true center sits inside that column), the "fringe" column
// is at EXACTLY the classic 50%-vote boundary every row (sum ===
// floor(factor*factor/2) -- the textbook antialiased edge case). Under
// the OLD 50% vote (sum >= half) BOTH columns register foreground, so the
// two merge (8-connectivity, adjacent columns) into one component of
// 2*tickLen blocks -- safely above despeckleNative=24 default, correctly
// preserved (matches Gauge's ~41-43 for tickLen=22, 2*22=44). Under a
// 100% ("ALL fine pixels dark") vote only the core column registers (the
// fringe column's sum is below total), so the component shrinks to just
// tickLen blocks -- at/under despeckleNative, DELETED outright by
// removeSmallComponents (matches Gauge's ~21-22). fragCount/pathCount
// can't see this failure mode (deleting a whole tick doesn't change
// potrace's path *count*, only its geometry) -- that's exactly why the
// original two-case harness missed it; this measures foreground pixel
// survival directly in the fine mask instead.
async function tickSurvival(page, factor, variant, despeckleNative, holeNative) {
  return page.evaluate(
    ({ factor, variant, despeckleNative, holeNative, sharedFns }) => {
      const build = new Function(sharedFns + '; return { cheapDespeckle };');
      const { cheapDespeckle } = build();

      const w = 240, h = 240; // native size, matches WORK_SIZE
      const ow = w * factor, oh = h * factor;
      const total = factor * factor;
      const half = Math.floor(total / 2); // exactly-50%-vote fringe sum

      const tickLen = 22;
      const cols = [30, 80, 130, 180]; // 4 well-separated native x positions
      const y0 = Math.floor(h * 0.5 - tickLen / 2);
      const ticks = cols.map(c => ({ core: c, fringe: c + 1, y0, y1: y0 + tickLen }));

      const mask = new Uint8Array(ow * oh);
      function setBlock(nx, ny, sum) {
        let remaining = sum;
        for (let dy = 0; dy < factor && remaining > 0; dy++) {
          for (let dx = 0; dx < factor && remaining > 0; dx++) {
            mask[(ny * factor + dy) * ow + (nx * factor + dx)] = 1;
            remaining--;
          }
        }
      }
      for (const t of ticks) {
        for (let ny = t.y0; ny < t.y1; ny++) {
          setBlock(t.core, ny, total);  // fully saturated core column
          setBlock(t.fringe, ny, half); // exactly-50% fringe column
        }
      }

      function tickSum(m, t) {
        let sum = 0;
        for (let ny = t.y0; ny < t.y1; ny++) {
          for (const nx of [t.core, t.fringe]) {
            for (let dy = 0; dy < factor; dy++) {
              for (let dx = 0; dx < factor; dx++) sum += m[(ny * factor + dy) * ow + (nx * factor + dx)];
            }
          }
        }
        return sum;
      }

      const before = ticks.map(t => tickSum(mask, t));
      const r = cheapDespeckle(mask, ow, oh, factor, w, h, despeckleNative, holeNative, variant);
      const after = ticks.map(t => tickSum(r.mask, t));

      return { before, after, despeckleInfo: { blocksChanged: r.blocksChanged, totalBlocks: r.totalBlocks } };
    },
    { factor, variant, despeckleNative, holeNative, sharedFns: SHARED_FNS }
  );
}

async function runPotrace(page, dataUrl, options) {
  return page.evaluate(
    async ({ dataUrl, options }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const svg = await window.__potraceMod.potrace(img, options);
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      function effectiveFill(el) {
        let n = el;
        while (n) { const f = n.getAttribute && n.getAttribute('fill'); if (f) return f; n = n.parentElement; }
        return null;
      }
      const paths = Array.from(doc.querySelectorAll('path')).map(p => ({
        fill: effectiveFill(p), dLength: (p.getAttribute('d') || '').length,
      }));
      return { svg, paths };
    },
    { dataUrl, options }
  );
}

async function collapsedMergeSvg(page, rawSvg, width, height) {
  return page.evaluate(
    ({ rawSvg, width, height }) => {
      function effectiveFill(el) {
        let n = el;
        while (n) { const f = n.getAttribute && n.getAttribute('fill'); if (f) return f; n = n.parentElement; }
        return null;
      }
      function effectiveTransform(el) {
        let n = el;
        while (n) { const t = n.getAttribute && n.getAttribute('transform'); if (t) return t; n = n.parentElement; }
        return null;
      }
      function luma(fill) {
        if (!fill) return 255;
        const m = fill.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        if (!m) return 255;
        const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
        return r * 0.299 + g * 0.587 + b * 0.114;
      }
      const doc = new DOMParser().parseFromString(rawSvg, 'image/svg+xml');
      const darkD = [];
      let transform = null;
      doc.querySelectorAll('path').forEach(p => {
        const fill = effectiveFill(p);
        if (luma(fill) < 128) {
          const d = p.getAttribute('d') || '';
          if (d) { darkD.push(d); if (!transform) transform = effectiveTransform(p); }
        }
      });
      const tAttr = transform ? ` transform="${transform}"` : '';
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><path fill="#000000" fill-rule="evenodd" stroke="none"${tAttr} d="${darkD.join(' ')}"/></svg>`;
    },
    { rawSvg, width, height }
  );
}

async function pixelDiffAgainstGroundTruth(page, svgStr, groundTruthDataUrl, size) {
  return page.evaluate(
    async ({ svgStr, groundTruthDataUrl, size }) => {
      async function toImageData(src, isSvg) {
        const img = new Image();
        const url = isSvg ? 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(src))) : src;
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        return ctx.getImageData(0, 0, size, size);
      }
      const gt = await toImageData(groundTruthDataUrl, false);
      const cand = await toImageData(svgStr, true);
      let diffPixels = 0, sqErr = 0;
      for (let i = 0; i < gt.data.length; i += 4) {
        const lumaA = gt.data[i] * 0.299 + gt.data[i + 1] * 0.587 + gt.data[i + 2] * 0.114;
        const lumaB = cand.data[i] * 0.299 + cand.data[i + 1] * 0.587 + cand.data[i + 2] * 0.114;
        const d = lumaA - lumaB;
        sqErr += d * d;
        if (Math.abs(d) > 40) diffPixels++;
      }
      const totalPixels = gt.data.length / 4;
      return { diffPixels, diffPct: +(100 * diffPixels / totalPixels).toFixed(3), rmse: +Math.sqrt(sqErr / totalPixels).toFixed(3) };
    },
    { svgStr, groundTruthDataUrl, size }
  );
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(BASE_URL);
  await loadPotrace(page);

  const VARIANTS = [
    { name: 'baseline-50pct', v: { kind: 'uniform', frac: 0.5 } },       // shipped in #34, has the #35 regression
    { name: 'uniform-any-pixel', v: { kind: 'uniform', frac: 0.01 } },   // sum>=1 -- makes things WORSE (see file header)
    { name: 'uniform-25pct', v: { kind: 'uniform', frac: 0.25 } },       // also worse
    { name: 'uniform-75pct', v: { kind: 'uniform', frac: 0.75 } },       // no measurable effect at factor=2
    { name: 'uniform-100pct', v: { kind: 'uniform', frac: 1.0 } },       // fixes aa-wordmark but DELETES hairline ticks (Gauge #35 review)
    { name: 'asym-remove-any-pixel', v: { kind: 'asymmetric', removeFrac: 0.01 } },
    { name: 'asym-remove-75pct', v: { kind: 'asymmetric', removeFrac: 0.75 } },
    { name: 'asym-remove-90pct', v: { kind: 'asymmetric', removeFrac: 0.9 } },
    { name: 'asym-remove-100pct', v: { kind: 'asymmetric', removeFrac: 1.0 } }, // still breaks ticks -- removal decision keys off the STRICT view's component size, same failure as uniform-100pct
    // Round 2, pre-boundary-gate (kept for comparison only -- Gauge's
    // second review found these carve interior holes into small
    // legitimate shapes; see small-dot-core case below). NOT the
    // production rule.
    { name: 'decoupled-spur1', v: { kind: 'decoupled', spurArea: 1 } },
    { name: 'decoupled-spur2', v: { kind: 'decoupled', spurArea: 2 } },
    { name: 'decoupled-spur4', v: { kind: 'decoupled', spurArea: 4 } },
    { name: 'decoupled-spur8', v: { kind: 'decoupled', spurArea: 8 } },
    { name: 'decoupled-spur12', v: { kind: 'decoupled', spurArea: 12 } },
    // Round 2, boundary-gated (Gauge's suggested fix (2)): only strip a
    // small strict component if it actually touches std-background
    // somewhere -- excludes fully-interior small cores.
    { name: 'decoupled-boundary-spur1', v: { kind: 'decoupled', spurArea: 1, requireBoundaryTouch: true } },
    { name: 'decoupled-boundary-spur2', v: { kind: 'decoupled', spurArea: 2, requireBoundaryTouch: true } },
    { name: 'decoupled-boundary-spur4', v: { kind: 'decoupled', spurArea: 4, requireBoundaryTouch: true } }, // WINNER -- ported to production as SPUR_AREA_CAP
    { name: 'decoupled-boundary-spur8', v: { kind: 'decoupled', spurArea: 8, requireBoundaryTouch: true } },
    { name: 'decoupled-boundary-spur12', v: { kind: 'decoupled', spurArea: 12, requireBoundaryTouch: true } },
  ];

  const cases = {};
  for (const kind of ['noisy-logo', 'aa-wordmark']) {
    const { jpegUrl } = await makeDegradedSource(page, kind, WORK_SIZE);
    const degradedDataUrl = await jpegToNoisyPng(page, jpegUrl, WORK_SIZE);

    const gtDataUrl = await page.evaluate(
      ({ kind, size }) => {
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#000';
        if (kind === 'noisy-logo') {
          ctx.beginPath();
          const cx = size / 2, cy = size / 2, rOuter = size * 0.42, rInner = size * 0.17, spikes = 6;
          for (let i = 0; i < spikes * 2; i++) {
            const r = i % 2 === 0 ? rOuter : rInner;
            const a = (Math.PI / spikes) * i - Math.PI / 2;
            const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.font = `bold ${Math.round(size * 0.32)}px Arial, sans-serif`;
          ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
          ctx.fillText('LOGO', size / 2, size * 0.38);
          ctx.beginPath();
          ctx.arc(size * 0.5, size * 0.72, size * 0.14, 0, Math.PI * 2);
          ctx.fill();
        }
        return c.toDataURL('image/png');
      },
      { kind, size: GT_SIZE }
    );

    cases[kind] = {};
    for (const { name, v } of VARIANTS) {
      cases[kind][name] = {};
      for (const factor of [2, 4]) {
        const mask = await buildMask(page, degradedDataUrl, factor, v);
        const result = await runPotrace(page, mask.dataUrl, { turdsize: 0, ...PRODUCTION_LIKE });
        const fragCount = result.paths.filter(p => p.dLength < 100).length;
        const collapsed = await collapsedMergeSvg(page, result.svg, mask.width, mask.height);
        const diff = await pixelDiffAgainstGroundTruth(page, collapsed, gtDataUrl, GT_SIZE);
        cases[kind][name][`F${factor}`] = {
          pathCount: result.paths.length,
          fragCount,
          diffPct: diff.diffPct,
          blocksChanged: mask.despeckleInfo.blocksChanged,
          totalBlocks: mask.despeckleInfo.totalBlocks,
        };
        if (process.env.DUMP_PNG && factor === 2) {
          const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'out-35-visual');
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, `${kind}__${name}__F${factor}-mask.png`), Buffer.from(mask.dataUrl.split(',')[1], 'base64'));
        }
      }
    }
  }

  // hairline-ticks: direct mask-pixel survival, no potrace/diffPct involved
  // (see tickSurvival's header comment for why fragCount/pathCount can't
  // see this failure mode). Only factor=2 matters (production's only
  // value), but factor=4 is reported too for completeness.
  const tickResults = {};
  for (const { name, v } of VARIANTS) {
    tickResults[name] = {};
    for (const factor of [2, 4]) {
      const r = await tickSurvival(page, factor, v, DESPECKLE_NATIVE, HOLE_NATIVE);
      const survivalPct = r.before.map((b, i) => b > 0 ? +(100 * r.after[i] / b).toFixed(1) : null);
      const deletedCount = survivalPct.filter(p => p !== null && p < 20).length;
      tickResults[name][`F${factor}`] = { before: r.before, after: r.after, survivalPct, deletedCount };
    }
  }

  console.log(JSON.stringify(cases, null, 2));
  console.log('\n=== SUMMARY: noisy-logo / aa-wordmark (potrace-based) ===');
  for (const kind of Object.keys(cases)) {
    console.log(`\n${kind}:`);
    for (const { name } of VARIANTS) {
      for (const factor of [2, 4]) {
        const r = cases[kind][name][`F${factor}`];
        console.log(`  ${name.padEnd(24)} F${factor}: diffPct=${r.diffPct}%  fragCount=${r.fragCount}  pathCount=${r.pathCount}  blocksChanged=${r.blocksChanged}/${r.totalBlocks}`);
      }
    }
  }

  console.log('\n=== SUMMARY: hairline-ticks (direct mask survival, despeckleNative=' + DESPECKLE_NATIVE + ') ===');
  for (const { name } of VARIANTS) {
    for (const factor of [2, 4]) {
      const r = tickResults[name][`F${factor}`];
      const flag = r.deletedCount > 0 ? `  <-- ${r.deletedCount}/4 TICKS DELETED` : '';
      console.log(`  ${name.padEnd(24)} F${factor}: before=[${r.before.join(', ')}] after=[${r.after.join(', ')}] survival%=[${r.survivalPct.join(', ')}]${flag}`);
    }
  }

  // small-dot-core: Gauge #35-review-round-2's regression case -- see
  // coreHoleCheck's header for why this is a deterministic construction
  // rather than a JPEG-degraded canvas source (organic reproduction of
  // this exact vote pattern isn't reliable, same conclusion tickSurvival
  // already reached). A cheap variant that carves the spurious interior
  // hole shows up as pathCount HIGHER than the full-BFS reference (the
  // hole renders as its own path/subpath, same instrument as aa-wordmark).
  // NOTE on the comparison baseline: full-BFS despeckle operates at FINE
  // resolution and therefore cleans up sub-native-pixel texture (like this
  // construction's moat ring, which is inherently un-flattened by ANY
  // native-resolution cheap variant including baseline-50pct -- untouched
  // blocks always keep 100% of their raw fine content, moat texture
  // included, a pre-existing #32-era tradeoff, not a #35 regression). That
  // makes full-BFS pathCount a noisy reference for THIS specific
  // comparison: baseline-50pct itself sits above it even with zero spur
  // logic involved. The apples-to-apples reference for isolating the spur
  // pass's OWN contribution is baseline-50pct on the SAME construction
  // (identical moat texture, zero spur logic) -- any variant's pathCount
  // above baseline's, for the SAME factor, is the spur pass's doing.
  // full-BFS pathCount is still reported for context.
  const dotResults = {};
  for (const factor of [2, 4]) {
    dotResults[`F${factor}`] = { variants: {} };
    let fullBfsPathCount = null;
    let baselinePathCount = null;
    for (const { name, v } of VARIANTS) {
      const r = await coreHoleCheck(page, factor, v, DESPECKLE_NATIVE, HOLE_NATIVE);
      if (fullBfsPathCount === null) {
        const fullPotrace = await runPotrace(page, r.fullDataUrl, { turdsize: 0, ...PRODUCTION_LIKE });
        fullBfsPathCount = fullPotrace.paths.length;
        dotResults[`F${factor}`].fullBfsPathCount = fullBfsPathCount;
        dotResults[`F${factor}`].stdArea = r.stdArea;
        dotResults[`F${factor}`].coreArea = r.coreArea;
      }
      const variantPotrace = await runPotrace(page, r.variantDataUrl, { turdsize: 0, ...PRODUCTION_LIKE });
      if (name === 'baseline-50pct') baselinePathCount = variantPotrace.paths.length;
      dotResults[`F${factor}`].variants[name] = {
        pathCount: variantPotrace.paths.length,
        blocksChanged: r.blocksChanged,
        spurBlocksRemoved: r.spurBlocksRemoved,
      };
    }
    dotResults[`F${factor}`].baselinePathCount = baselinePathCount;
  }

  console.log('\n=== SUMMARY: small-dot-core (interior-hole check, despeckleNative=' + DESPECKLE_NATIVE + ') ===');
  for (const factor of [2, 4]) {
    const r = dotResults[`F${factor}`];
    console.log(`  F${factor}: stdArea=${r.stdArea} coreArea=${r.coreArea} full-BFS reference pathCount=${r.fullBfsPathCount}  baseline-50pct pathCount=${r.baselinePathCount}`);
    for (const { name } of VARIANTS) {
      const v = r.variants[name];
      const flag = v.pathCount > r.baselinePathCount ? `  <-- ${v.pathCount - r.baselinePathCount} EXTRA PATH(S) VS BASELINE, LIKELY INTERIOR HOLE` : '';
      const spur = v.spurBlocksRemoved !== undefined ? ` spurBlocksRemoved=${v.spurBlocksRemoved}` : '';
      console.log(`    ${name.padEnd(24)} pathCount=${v.pathCount} blocksChanged=${v.blocksChanged}${spur}${flag}`);
    }
  }

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
