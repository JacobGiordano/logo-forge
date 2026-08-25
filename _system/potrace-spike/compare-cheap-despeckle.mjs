// Cheap-despeckle spike for issue #32 (candidate direction 3): #30 found
// that despeckle/hole-fill's flood-fill passes at the UPSAMPLED mask
// resolution are the dominant cost (>80% of total pipeline time at
// 2048x2048@4x) and the dominant memory driver of the 4200x4200 OOM crash —
// removeSmallComponents/fillSmallHoles each allocate a `visited` Uint8Array
// AND an `Int32Array` BFS queue at the FULL upsampled resolution, on top of
// the mask itself. At 4200x4200@4x (16800x16800, ~282M px) that queue alone
// is ~1.1GB, plus ~282MB visited, PER CALL (despeckle then hole-fill, so
// this happens twice).
//
// This tests a cheaper algorithm that avoids allocating ANY buffer at the
// upsampled resolution for the flood-fill itself:
//
//   1. Downsample the fine (upsampled+thresholded) mask back to NATIVE
//      resolution via majority-vote per factor x factor block.
//   2. Run the EXACT same removeSmallComponents/fillSmallHoles (copied
//      verbatim from js/app.js) on this small native-resolution mask, with
//      the NATIVE-unit maxArea thresholds (no factor^2 scaling needed --
//      we're back at native resolution, so this is the same cost profile as
//      TODAY's production pipeline).
//   3. Apply the native-resolution flip DECISIONS back onto the fine mask:
//      for each native pixel whose coarse value changed (component removed
//      -> background, or hole filled -> foreground), flatten its entire
//      factor x factor fine block to the new value. Blocks that did NOT
//      change are left untouched, preserving the bilinear step's sub-pixel
//      edge precision exactly where no cleanup was needed.
//
// This trades exactness for memory: a speck/hole smaller than roughly one
// native pixel might not flip the majority vote and could survive
// undespeckled (whereas full high-res despeckle catches it exactly). The
// quality section below tests whether that approximation error is visible
// in practice, using #30's noisy/degraded real-image test set (which
// specifically has salt-noise speckles smaller than the shapes' vector
// edges -- exactly the adversarial case for this approximation).
//
// Two sections:
//   PART A (perf/memory): same NATIVE_SIZES x FACTORS grid as #30's
//     profile-bilinear-perf.mjs / #32's profile-perf-fix-candidates.mjs,
//     including the two OOM cells (4200 @ 2x/4x), comparing full high-res
//     despeckle/hole-fill against this block-approx version.
//   PART B (quality): #30's real-image methodology (noisy-logo,
//     aa-wordmark degraded sources, WORK_SIZE=240, GT_SIZE=960 ground
//     truth) comparing diff%/fragCount of block-approx vs full high-res
//     despeckle vs the app baselines.
//
// Usage: node _system/potrace-spike/compare-cheap-despeckle.mjs
// Requires a dev server already running; BASE_URL below must match.
// Outputs: _system/potrace-spike/out-32-cheap-despeckle/ (gitignored).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out-32-cheap-despeckle');
fs.mkdirSync(OUT, { recursive: true });
const BASE_URL = 'http://localhost:4321';

const NATIVE_SIZES = [512, 1024, 2048, 3000, 4200];
const FACTORS = [2, 4];
const DESPECKLE_NATIVE = 24;
const HOLE_NATIVE = 12;

const WORK_SIZE = 240;
const GT_SIZE = 960;
const TIGHT = { alphamax: 0.35, opttolerance: 0.05 };
const PRODUCTION_LIKE = {
  turnpolicy: 4, opticurve: 1, pathonly: false,
  extractcolors: true, posterizelevel: 2, posterizationalgorithm: 0,
  ...TIGHT,
};

// ── Shared JS injected into page.evaluate blocks ────────────────────────
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

// Read-only sibling of removeSmallComponents: labels 8-connected
// foreground components without mutating the mask, returning a
// component-id-per-cell array plus an id -> area map. Copied verbatim from
// sweep-despeckle-threshold.mjs's labelComponents -- keep in sync.
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
      labels[idx] = id; area++;
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

// Block-approx cheap despeckle: downsample fine mask to native res via
// majority vote, clean at native res (cheap), apply flip decisions back to
// fine res by flattening only CHANGED blocks. No BFS buffer is ever
// allocated at the fine (upsampled) resolution.
//
// Rule finalized by issue #35 (see sweep-despeckle-threshold.mjs and
// js/bilinear-worker.js's cheapDespeckle for the full rationale, including
// why the first attempt -- requiring ALL factor x factor fine pixels
// foreground -- was a correctness bug that deleted legitimate hairline
// strokes). Standard 50%-vote despeckle/hole-fill runs unchanged; a
// separate read-only pass over a stricter 100%-vote view then strips only
// components whose isolated area is tiny (<= SPUR_AREA_CAP, also capped by
// despeckleNative) -- catching noise specks bridged onto real geometry
// without touching real thin strokes. Validated at factor=2 only, do not
// reuse at factor=4 without re-sweeping.
const SPUR_AREA_CAP = 4;
function cheapDespeckle(fineMask, ow, oh, factor, w, h, despeckleNative, holeNative) {
  const coarseStd = new Uint8Array(w * h);
  const coarseStrict = new Uint8Array(w * h);
  const total = factor * factor;
  const half = total / 2;
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
  let cleaned = removeSmallComponents(coarseStd, w, h, despeckleNative);
  cleaned = fillSmallHoles(cleaned, w, h, holeNative);

  const spurArea = despeckleNative > 0 ? Math.min(despeckleNative, SPUR_AREA_CAP) : 0;
  if (spurArea > 0) {
    const { labels, areas } = labelComponents(coarseStrict, w, h);
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] !== 1 || coarseStrict[i] !== 1) continue;
      if (areas.get(labels[i]) <= spurArea) cleaned[i] = 0;
    }
  }

  // apply back: only touch fine blocks whose coarse decision changed
  const out = fineMask; // mutate in place, no extra fine-res allocation
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

// ═══════════════════════ PART A: perf/memory grid ═══════════════════════
function makeSourceGray() {
  return `
    function makeGray(w, h) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(w * 0.5, h * 0.5, Math.min(w, h) * 0.35, 0, Math.PI * 2);
      ctx.fill();
      const id = ctx.getImageData(0, 0, w, h);
      for (let i = 0; i < id.data.length; i += 4) {
        if (Math.random() < 0.002) {
          const v = Math.random() < 0.5 ? 0 : 255;
          id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
        }
      }
      const gray = new Float64Array(w * h);
      for (let i = 0, px = 0; i < id.data.length; i += 4, px++) {
        const a = id.data[i + 3] / 255;
        gray[px] = (id.data[i] * 0.299 + id.data[i + 1] * 0.587 + id.data[i + 2] * 0.114) * a + 255 * (1 - a);
      }
      return gray;
    }
  `;
}

async function runPerfCell(page, { nativeSize, factor, mode }) {
  // mode: 'full' (today's proposed composition, high-res flood-fill) or
  // 'cheap' (block-approx, native-res flood-fill only)
  return page.evaluate(
    ({ nativeSize, factor, mode, despeckleNative, holeNative, sharedFns, makeGraySrc }) => {
      const build = new Function(sharedFns + makeGraySrc + '; return { computeOtsuThreshold, removeSmallComponents, fillSmallHoles, cheapDespeckle, makeGray };');
      const { computeOtsuThreshold, removeSmallComponents, fillSmallHoles, cheapDespeckle, makeGray } = build();
      const w = nativeSize, h = nativeSize;
      const gray = makeGray(w, h);
      const t0 = performance.now();
      try {
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
            const v00 = gray[y0 * w + x0], v10 = gray[y0 * w + x1];
            const v01 = gray[y1 * w + x0], v11 = gray[y1 * w + x1];
            const top = v00 * (1 - fx) + v10 * fx;
            const bot = v01 * (1 - fx) + v11 * fx;
            up[oy * ow + ox] = top * (1 - fy) + bot * fy;
          }
        }
        const tAfterBilinear = performance.now();
        const hist = new Uint32Array(256);
        for (let i = 0; i < up.length; i++) hist[Math.max(0, Math.min(255, Math.round(up[i])))]++;
        const threshold = computeOtsuThreshold(hist, up.length);
        let mask = new Uint8Array(ow * oh);
        for (let i = 0; i < up.length; i++) mask[i] = up[i] < threshold ? 1 : 0;
        const tAfterBinarize = performance.now();

        let despeckleInfo = null;
        if (mode === 'full') {
          const factorAreaScale = factor * factor;
          mask = removeSmallComponents(mask, ow, oh, despeckleNative * factorAreaScale);
          mask = fillSmallHoles(mask, ow, oh, holeNative * factorAreaScale);
        } else {
          const r = cheapDespeckle(mask, ow, oh, factor, w, h, despeckleNative, holeNative);
          mask = r.mask;
          despeckleInfo = { blocksChanged: r.blocksChanged, totalBlocks: r.totalBlocks };
        }
        const tAfterDespeckle = performance.now();

        return {
          outcome: 'success',
          bilinearMs: +(tAfterBilinear - t0).toFixed(2),
          binarizeMs: +(tAfterBinarize - tAfterBilinear).toFixed(2),
          despeckleMs: +(tAfterDespeckle - tAfterBinarize).toFixed(2),
          totalMs: +(tAfterDespeckle - t0).toFixed(2),
          despeckleInfo,
        };
      } catch (err) {
        return { outcome: 'error', error: String(err && err.message || err), totalMs: +(performance.now() - t0).toFixed(2) };
      }
    },
    { nativeSize, factor, mode, despeckleNative: DESPECKLE_NATIVE, holeNative: HOLE_NATIVE, sharedFns: SHARED_FNS, makeGraySrc: makeSourceGray() }
  );
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), ms);
  });
  return Promise.race([promise, timeout]).then((r) => {
    clearTimeout(timer);
    if (r && r.__timedOut) { onTimeout(); return { outcome: 'timeout', error: `exceeded ${ms}ms, browser force-killed` }; }
    return r;
  });
}

// full-mode despeckle/hole-fill at 4200 native is already established by
// issue #30 to OOM-crash the tab (see findings doc's Part 2 table) — both
// factors. Re-attempting it here risks hanging this session for zero new
// information (this script's own earlier attempt did exactly that, see
// #32 findings section for why it's skipped rather than re-run). The
// 'cheap' mode at 4200 IS run — that's the new data point this script
// exists to collect (does avoiding the high-res BFS buffer avoid the OOM).
const SKIP_FULL_AT = new Set([4200]);

async function runPartA() {
  console.log('\n\n########## PART A: perf/memory, full high-res despeckle vs cheap block-approx ##########');
  const results = [];
  for (const nativeSize of NATIVE_SIZES) {
    for (const factor of FACTORS) {
      for (const mode of ['full', 'cheap']) {
        const label = `${nativeSize}x${nativeSize} @ ${factor}x [${mode}]`;
        if (mode === 'full' && SKIP_FULL_AT.has(nativeSize)) {
          console.log(`\n=== ${label} === SKIPPED (already established as OOM-crash by issue #30; see findings doc)`);
          results.push({ nativeSize, factor, mode, outcome: 'skipped-known-oom-see-issue-30' });
          continue;
        }
        // Fresh browser PROCESS per cell, not just a fresh page — the
        // control test in this session's #32 investigation (see findings
        // doc) found that even fresh PAGES within the same browser process
        // accumulate enough memory pressure to crash at large sizes; a
        // fresh process is the only reliable isolation, and also lets a
        // hung/timed-out cell be killed without corrupting later cells.
        const cellBrowser = await chromium.launch();
        const page = await cellBrowser.newPage({ viewport: { width: 800, height: 600 } });
        let crashed = false;
        page.on('crash', () => { crashed = true; });
        console.log(`\n=== ${label} ===`);
        const timeoutMs = nativeSize >= 3000 ? 40000 : 20000;
        let r;
        try {
          await page.goto(BASE_URL, { timeout: 15000 });
          r = await withTimeout(
            runPerfCell(page, { nativeSize, factor, mode }),
            timeoutMs,
            () => { cellBrowser.close().catch(() => {}); }
          );
        } catch (err) {
          r = { outcome: crashed ? 'page-crashed' : 'evaluate-threw', error: String(err && err.message || err) };
        }
        console.log(JSON.stringify(r, null, 2));
        results.push({ nativeSize, factor, mode, ...r });
        try { await cellBrowser.close(); } catch (_) {}
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'perf-results.json'), JSON.stringify(results, null, 2));

  console.log('\n=== SUMMARY: full vs cheap despeckle ===');
  console.log('size'.padEnd(14), 'factor'.padEnd(8), 'full totalMs'.padEnd(16), 'cheap totalMs'.padEnd(16), 'speedup');
  for (const nativeSize of NATIVE_SIZES) {
    for (const factor of FACTORS) {
      const full = results.find(r => r.nativeSize === nativeSize && r.factor === factor && r.mode === 'full');
      const cheap = results.find(r => r.nativeSize === nativeSize && r.factor === factor && r.mode === 'cheap');
      const fullStr = full.outcome === 'success' ? `${full.totalMs}ms` : full.outcome;
      const cheapStr = cheap.outcome === 'success' ? `${cheap.totalMs}ms` : cheap.outcome;
      const speedup = (full.outcome === 'success' && cheap.outcome === 'success') ? `${(full.totalMs / cheap.totalMs).toFixed(1)}x` : '—';
      console.log(`${nativeSize}x${nativeSize}`.padEnd(14), `${factor}x`.padEnd(8), fullStr.padEnd(16), cheapStr.padEnd(16), speedup);
    }
  }
  return results;
}

// ═══════════════════════ PART B: quality on real-image set ═══════════════
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

async function loadPotrace(page) {
  await page.evaluate(async () => {
    if (window.__potraceMod) return;
    const mod = await import('/js/potrace-wasm.js');
    await mod.init();
    window.__potraceMod = mod;
  });
}

async function buildMask(page, dataUrl, factor, mode, { despeckleNative, holeNative }) {
  return page.evaluate(
    async ({ dataUrl, factor, mode, despeckleNative, holeNative, sharedFns }) => {
      const build = new Function(sharedFns + '; return { computeOtsuThreshold, removeSmallComponents, fillSmallHoles, cheapDespeckle };');
      const { computeOtsuThreshold, removeSmallComponents, fillSmallHoles, cheapDespeckle } = build();

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
      let sum = 0;
      for (let t = 0; t < 256; t++) sum += t * hist[t];
      let sumB = 0, weightB = 0, maxVariance = -1, threshold = 128;
      const total = up.length;
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

      let mask = new Uint8Array(ow * oh);
      for (let i = 0; i < up.length; i++) mask[i] = up[i] < threshold ? 1 : 0;

      let despeckleInfo = null;
      if (mode === 'full') {
        const factorAreaScale = factor * factor;
        mask = removeSmallComponents(mask, ow, oh, despeckleNative * factorAreaScale);
        mask = fillSmallHoles(mask, ow, oh, holeNative * factorAreaScale);
      } else {
        const r = cheapDespeckle(mask, ow, oh, factor, w, h, despeckleNative, holeNative);
        mask = r.mask;
        despeckleInfo = { blocksChanged: r.blocksChanged, totalBlocks: r.totalBlocks };
      }

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
    { dataUrl, factor, mode, despeckleNative, holeNative, sharedFns: SHARED_FNS }
  );
}

async function runPotrace(page, dataUrl, options) {
  return page.evaluate(
    async ({ dataUrl, options }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const t0 = performance.now();
      const svg = await window.__potraceMod.potrace(img, options);
      const t1 = performance.now();
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      function effectiveFill(el) {
        let n = el;
        while (n) { const f = n.getAttribute && n.getAttribute('fill'); if (f) return f; n = n.parentElement; }
        return null;
      }
      const paths = Array.from(doc.querySelectorAll('path')).map(p => ({
        fill: effectiveFill(p), dLength: (p.getAttribute('d') || '').length,
      }));
      return { svg, paths, ms: t1 - t0 };
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

function dataUrlToFile(dataUrl, outPath) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(outPath, buf);
  return outPath;
}

async function runPartB(browser) {
  console.log('\n\n########## PART B: quality, cheap block-approx despeckle vs full high-res despeckle ##########');
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(BASE_URL);
  await loadPotrace(page);

  const summary = {};
  for (const kind of ['noisy-logo', 'aa-wordmark']) {
    console.log(`\n=== Case: ${kind} ===`);
    const caseOut = {};
    const { jpegUrl } = await makeDegradedSource(page, kind, WORK_SIZE);
    const degradedDataUrl = await jpegToNoisyPng(page, jpegUrl, WORK_SIZE);
    dataUrlToFile(degradedDataUrl, path.join(OUT, `${kind}__0-degraded-source.png`));

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
    fs.writeFileSync(path.join(OUT, `${kind}__gt-ground-truth.png`), Buffer.from(gtDataUrl.split(',')[1], 'base64'));

    for (const mode of ['full', 'cheap']) {
      for (const factor of [2, 4]) {
        const mask = await buildMask(page, degradedDataUrl, factor, mode, {
          despeckleNative: DESPECKLE_NATIVE, holeNative: HOLE_NATIVE,
        });
        const result = await runPotrace(page, mask.dataUrl, { turdsize: 0, ...PRODUCTION_LIKE });
        const fragCount = result.paths.filter(p => p.dLength < 100).length;
        const collapsed = await collapsedMergeSvg(page, result.svg, mask.width, mask.height);
        const diff = await pixelDiffAgainstGroundTruth(page, collapsed, gtDataUrl, GT_SIZE);
        const key = `${mode}-F${factor}`;
        caseOut[key] = {
          otsuThreshold: mask.threshold,
          pathCount: result.paths.length,
          fragCount,
          fragPct: result.paths.length ? +(100 * fragCount / result.paths.length).toFixed(1) : 0,
          collapsedBytes: collapsed.length,
          diff,
          despeckleInfo: mask.despeckleInfo,
        };
        console.log(`${mode} F=${factor}:`, caseOut[key]);
        dataUrlToFile(mask.dataUrl, path.join(OUT, `${kind}__${key}-mask.png`));
      }
    }
    summary[kind] = caseOut;
  }

  fs.writeFileSync(path.join(OUT, 'quality-summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n=== SUMMARY: quality (diffPct vs clean 4x ground truth) ===');
  for (const kind of Object.keys(summary)) {
    console.log(`\n${kind}:`);
    for (const factor of [2, 4]) {
      const full = summary[kind][`full-F${factor}`];
      const cheap = summary[kind][`cheap-F${factor}`];
      console.log(`  F${factor}: full despeckle diffPct=${full.diff.diffPct}% fragCount=${full.fragCount}  |  cheap despeckle diffPct=${cheap.diff.diffPct}% fragCount=${cheap.fragCount} (blocksChanged=${cheap.despeckleInfo.blocksChanged}/${cheap.despeckleInfo.totalBlocks})`);
    }
  }
  await page.close();
  return summary;
}

async function main() {
  await runPartA(); // manages its own per-cell browsers, see runPartA
  const browser = await chromium.launch();
  await runPartB(browser);
  await browser.close();
  console.log('\nDone. Output in', OUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
