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
// This sweep tested two directions the findings doc raised: (1) a uniform
// non-50% vote fraction, (2) an asymmetric threshold (stricter on
// despeckle's removal side, standard 50% on hole-fill's side, chained by
// applying despeckle's strict-vote removal decisions onto the standard-vote
// baseline before hole-fill runs -- see the `asymmetric` variant kind
// below). Counter to the findings doc's initial guess, LOWERING the
// removal-side threshold (easier to register as foreground) made both
// cases measurably worse, not better -- it merges isolated noise/AA-edge
// pixels into larger connected coarse components that exceed the despeckle
// area threshold and survive, actually growing fragment/path counts (see
// uniform-any-pixel/uniform-25pct results below). RAISING the threshold to
// 100% (a block only counts as foreground if EVERY fine pixel in it is
// foreground -- an AND-downsample instead of a majority vote) is what
// closes the gap: at factor=2 (production's only value -- see
// js/bilinear-worker.js's cheapDespeckle) it exactly matches full-BFS
// despeckle's pathCount/fragCount on aa-wordmark while leaving noisy-logo
// bit-identical, across every despeckleNative/holeNative pairing tested
// (0/0, default 24/12, 48/24, 4/4). At factor=4 the same rule is
// catastrophic (pathCount balloons 10x+) -- irrelevant to what ships today
// since factor is hardcoded to 2, but a landmine if that ever changes
// without re-running this sweep. Uniform and asymmetric variants perform
// almost identically at the winning threshold; uniform was ported to
// production for simplicity (see js/bilinear-worker.js).
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
    { name: 'uniform-100pct', v: { kind: 'uniform', frac: 1.0 } },       // WINNER -- ported to production
    { name: 'asym-remove-any-pixel', v: { kind: 'asymmetric', removeFrac: 0.01 } },
    { name: 'asym-remove-100pct', v: { kind: 'asymmetric', removeFrac: 1.0 } }, // near-identical to uniform-100pct, more complex
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

  console.log(JSON.stringify(cases, null, 2));
  console.log('\n=== SUMMARY ===');
  for (const kind of Object.keys(cases)) {
    console.log(`\n${kind}:`);
    for (const { name } of VARIANTS) {
      for (const factor of [2, 4]) {
        const r = cases[kind][name][`F${factor}`];
        console.log(`  ${name.padEnd(24)} F${factor}: diffPct=${r.diffPct}%  fragCount=${r.fragCount}  pathCount=${r.pathCount}  blocksChanged=${r.blocksChanged}/${r.totalBlocks}`);
      }
    }
  }

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
