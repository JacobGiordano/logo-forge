// Control test for profile-perf-fix-candidates.mjs's Part A (Worker
// offload). That test's Worker cells all used a FRESH page per cell
// (withFreshPage), but #30's original profile-bilinear-perf.mjs REUSED one
// page across its whole NATIVE_SIZES x FACTORS loop (only reloading after a
// crash). That's a confound: "the worker fixed it" and "a fresh page/context
// fixed it" are two different hypotheses, and the Part A run alone can't
// distinguish them.
//
// This script runs the SAME main-thread (no Worker) pipeline, at the SAME
// two cells that OOM-crashed in #30 (4200x4200 @ 2x and @ 4x), but with a
// FRESH page per cell — isolating "fresh page" from "worker" so Part A's
// result can be attributed correctly.
//
// Usage: node _system/potrace-spike/profile-worker-control.mjs
// Requires a dev server already running; BASE_URL below must match.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'http://localhost:4321';
const DESPECKLE_NATIVE = 24;
const HOLE_NATIVE = 12;

const CELLS = [
  { nativeSize: 4200, factor: 2 },
  { nativeSize: 4200, factor: 4 },
  // also re-check 3000@4x (17.6x slower, but did NOT crash in #30) as a
  // sanity control that fresh-page isn't uniformly changing behavior
  { nativeSize: 3000, factor: 4 },
];

async function runMainThread(page, { nativeSize, factor }) {
  return page.evaluate(
    ({ nativeSize, factor, despeckleNative, holeNative }) => {
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

      const c = document.createElement('canvas');
      c.width = nativeSize; c.height = nativeSize;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, nativeSize, nativeSize);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(nativeSize * 0.5, nativeSize * 0.5, nativeSize * 0.35, 0, Math.PI * 2);
      ctx.fill();
      const id = ctx.getImageData(0, 0, nativeSize, nativeSize);
      for (let i = 0; i < id.data.length; i += 4) {
        if (Math.random() < 0.002) {
          const v = Math.random() < 0.5 ? 0 : 255;
          id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
        }
      }
      const gray = new Float64Array(nativeSize * nativeSize);
      for (let i = 0, px = 0; i < id.data.length; i += 4, px++) {
        const a = id.data[i + 3] / 255;
        gray[px] = (id.data[i] * 0.299 + id.data[i + 1] * 0.587 + id.data[i + 2] * 0.114) * a + 255 * (1 - a);
      }

      const t0 = performance.now();
      try {
        const w = nativeSize, h = nativeSize, ow = w * factor, oh = h * factor;
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
        const hist = new Uint32Array(256);
        for (let i = 0; i < up.length; i++) hist[Math.max(0, Math.min(255, Math.round(up[i])))]++;
        const threshold = computeOtsuThreshold(hist, up.length);
        let mask = new Uint8Array(ow * oh);
        for (let i = 0; i < up.length; i++) mask[i] = up[i] < threshold ? 1 : 0;
        const factorAreaScale = factor * factor;
        mask = removeSmallComponents(mask, ow, oh, despeckleNative * factorAreaScale);
        mask = fillSmallHoles(mask, ow, oh, holeNative * factorAreaScale);
        return { outcome: 'success', totalMs: +(performance.now() - t0).toFixed(2), maskLen: mask.length };
      } catch (err) {
        return { outcome: 'error', error: String(err && err.message || err), totalMs: +(performance.now() - t0).toFixed(2) };
      }
    },
    { nativeSize, factor, despeckleNative: DESPECKLE_NATIVE, holeNative: HOLE_NATIVE }
  );
}

async function main() {
  const browser = await chromium.launch();
  const results = [];
  for (const cell of CELLS) {
    console.log(`\n=== MAIN THREAD, fresh page: ${cell.nativeSize}x${cell.nativeSize} @ ${cell.factor}x ===`);
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    let crashed = false;
    page.on('crash', () => { crashed = true; console.log('  >>> PAGE CRASH EVENT FIRED <<<'); });
    await page.goto(BASE_URL);
    let r;
    try {
      r = await runMainThread(page, cell);
    } catch (err) {
      r = { outcome: crashed ? 'page-crashed' : 'evaluate-threw', error: String(err && err.message || err) };
    }
    console.log(JSON.stringify(r, null, 2));
    results.push({ ...cell, ...r, crashed });
    try { await page.close({ runBeforeUnload: false }); } catch (_) {}
  }
  await browser.close();

  const OUT = path.join(__dirname, 'out-32-perf');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'worker-control.json'), JSON.stringify(results, null, 2));
  console.log('\nDone.', JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
