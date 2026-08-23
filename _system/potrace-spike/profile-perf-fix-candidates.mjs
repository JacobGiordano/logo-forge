// Perf-fix spike for issue #32 (follow-up to #27/#30's bilinear-presupersample
// findings). #30 established that bilinear-presupersample OOM-crashes the
// browser tab at realistic upload sizes (4200x4200 @ 2x and 4x), and that the
// dominant cost is despeckle/hole-fill's flood-fill passes running at the
// upsampled mask resolution — NOT the bilinear resample itself, and that this
// is fundamentally a MEMORY problem (simultaneous large Float64Array +
// despeckle/hole-fill BFS buffers), not a main-thread-blocking problem.
//
// This script tests candidate fixes #32 lists as directions 1 and 2:
//
//   (1) Web Worker offload: move the whole bilinear+despeckle+hole-fill
//       pipeline off the main thread into a dedicated Worker, and re-measure
//       whether the SAME sizes/factors that OOM-crashed the tab in #30 still
//       crash, and if so, whether the crash is now CONTAINED (a catchable
//       Worker 'error'/termination that the page can recover from) instead of
//       taking down the whole tab. This directly tests #30's root-cause
//       finding: if the blocker is memory capacity (not main-thread
//       blocking), a Worker predicts to NOT fix the crash by itself, since
//       dedicated Workers share the same renderer process and address space
//       as their page in Chromium — only isolate/heap-limit failures would be
//       contained, not process-level OOM. This script measures which one
//       actually happens, rather than assuming.
//
//   (2) Capped/clamped effective supersample factor: instead of a fixed
//       upscale factor, clamp the EFFECTIVE factor so the upsampled output
//       resolution never exceeds a fixed pixel-dimension ceiling
//       (OUTPUT_CAP), i.e. effectiveFactor = min(requestedFactor,
//       OUTPUT_CAP / nativeSize). This measures, across the same native-size
//       grid #30 used, (a) whether capping avoids the crash entirely, (b)
//       what the resulting effective factor collapses to at large native
//       sizes (does supersampling become a no-op before it becomes safe?),
//       and (c) perf/memory cost at the cap.
//
// This is read-only profiling/investigation — no js/app.js changes. All
// mask/despeckle code is copied near-verbatim from js/app.js and from #30's
// profile-bilinear-perf.mjs, reused rather than reimplemented, purely to
// measure candidate-fix behavior in isolation.
//
// Usage: node _system/potrace-spike/profile-perf-fix-candidates.mjs
// Requires a dev server already running; BASE_URL below must match.
// Outputs: printed tables + _system/potrace-spike/out-32-perf/results.json
// (gitignored via the existing out-*/ pattern).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out-32-perf');
fs.mkdirSync(OUT, { recursive: true });
const BASE_URL = 'http://localhost:4321';

// Same grid as #30's profile-bilinear-perf.mjs, for direct comparability —
// including the two cells (4200 @ 2x, 4200 @ 4x) that OOM-crashed the tab.
const NATIVE_SIZES = [512, 1024, 2048, 3000, 4200];
const FACTORS = [2, 4];

const DESPECKLE_NATIVE = 24;
const HOLE_NATIVE = 12;

// ── Shared pipeline source, injected into both the main thread (for the
// "today" baseline and the capped-factor variant) and a Worker (for the
// offload test) — kept as one string so both contexts run byte-identical
// algorithms, never two hand-copies that could drift apart.
const PIPELINE_SRC = `
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

function runPipeline(gray, w, h, factor, despeckleNative, holeNative) {
  const t = {};
  let t0 = performance.now();
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
  t.bilinear = performance.now() - t0;

  t0 = performance.now();
  const hist = new Uint32Array(256);
  for (let i = 0; i < up.length; i++) hist[Math.max(0, Math.min(255, Math.round(up[i])))]++;
  const threshold = computeOtsuThreshold(hist, up.length);
  t.otsu = performance.now() - t0;

  t0 = performance.now();
  let mask = new Uint8Array(ow * oh);
  for (let i = 0; i < up.length; i++) mask[i] = up[i] < threshold ? 1 : 0;
  t.binarize = performance.now() - t0;

  const factorAreaScale = factor * factor;
  t0 = performance.now();
  mask = removeSmallComponents(mask, ow, oh, despeckleNative * factorAreaScale);
  t.despeckle = performance.now() - t0;

  t0 = performance.now();
  mask = fillSmallHoles(mask, ow, oh, holeNative * factorAreaScale);
  t.holeFill = performance.now() - t0;

  return { mask, width: ow, height: oh, threshold, timings: t };
}
`;

function makeSourceInPage() {
  // Runs in-page: builds a synthetic gray-luminance Float64Array of the
  // requested native size with real bimodal content + speckle noise, same
  // convention as #30's profile-bilinear-perf.mjs (timing/memory harness,
  // content just needs to be realistic enough to give despeckle/hole-fill
  // genuine work, not to be photorealistic).
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

// ── (1) Web Worker offload test ─────────────────────────────────────────
async function runWorkerTest(page, { nativeSize, factor }) {
  return page.evaluate(
    ({ nativeSize, factor, despeckleNative, holeNative, pipelineSrc, makeGraySrc }) => {
      return new Promise((resolve) => {
        const workerBody = `
          ${pipelineSrc}
          self.onmessage = (e) => {
            const { gray, w, h, factor, despeckleNative, holeNative } = e.data;
            try {
              const t0 = performance.now();
              const result = runPipeline(gray, w, h, factor, despeckleNative, holeNative);
              const total = performance.now() - t0;
              // Transfer the mask back (Transferable) — this is what a real
              // implementation would need to hand back to the main thread
              // for canvas rendering / potrace tracing.
              self.postMessage({ ok: true, total, timings: result.timings, maskLen: result.mask.length, width: result.width, height: result.height }, [result.mask.buffer]);
            } catch (err) {
              self.postMessage({ ok: false, error: String(err && err.message || err) });
            }
          };
        `;
        const blob = new Blob([workerBody], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        let settled = false;
        let worker;
        const done = (result) => {
          if (settled) return;
          settled = true;
          try { worker && worker.terminate(); } catch (_) {}
          URL.revokeObjectURL(url);
          resolve(result);
        };

        const wallStart = performance.now();
        try {
          worker = new Worker(url);
        } catch (err) {
          done({ outcome: 'worker-construction-failed', error: String(err && err.message || err) });
          return;
        }

        worker.onmessage = (e) => {
          const wallTotal = performance.now() - wallStart;
          if (e.data && e.data.ok) {
            done({ outcome: 'success', workerInternalMs: e.data.total, wallMs: +wallTotal.toFixed(2), timings: e.data.timings, maskLen: e.data.maskLen });
          } else {
            done({ outcome: 'worker-reported-error', error: e.data && e.data.error, wallMs: +wallTotal.toFixed(2) });
          }
        };
        worker.onerror = (e) => {
          const wallTotal = performance.now() - wallStart;
          done({ outcome: 'worker-onerror', error: e.message || String(e), wallMs: +wallTotal.toFixed(2) });
        };
        // Hard timeout — if the worker silently hangs (rather than crashing
        // or erroring), don't let this test hang forever.
        setTimeout(() => done({ outcome: 'timeout-no-response', wallMs: +(performance.now() - wallStart).toFixed(2) }), 45000);

        // Build source on main thread (matches how the real app reads
        // canvas.getImageData on the main thread today — canvas access
        // requires the main thread / OffscreenCanvas, not tested here since
        // OffscreenCanvas is a separate, larger architectural change than
        // "move despeckle/hole-fill to a Worker").
        const mkGray = new Function(makeGraySrc + '; return makeGray(arguments[0], arguments[1]);');
        const gray = mkGray(nativeSize, nativeSize);
        try {
          worker.postMessage(
            { gray, w: nativeSize, h: nativeSize, factor, despeckleNative, holeNative },
            [gray.buffer]
          );
        } catch (err) {
          done({ outcome: 'postmessage-failed', error: String(err && err.message || err) });
        }
      });
    },
    { nativeSize, factor, despeckleNative: DESPECKLE_NATIVE, holeNative: HOLE_NATIVE, pipelineSrc: PIPELINE_SRC, makeGraySrc: makeSourceInPage() }
  );
}

// ── (2) Capped effective supersample factor test (main thread, matching
// today's architecture — no worker) ─────────────────────────────────────
async function runCappedTest(page, { nativeSize, factor, outputCap }) {
  const effectiveFactor = Math.min(factor, outputCap / nativeSize);
  return page.evaluate(
    ({ nativeSize, effectiveFactor, despeckleNative, holeNative, pipelineSrc, makeGraySrc }) => {
      const mkGray = new Function(makeGraySrc + '; return makeGray(arguments[0], arguments[1]);');
      const runPipelineFn = new Function('gray', 'w', 'h', 'factor', 'despeckleNative', 'holeNative',
        pipelineSrc + '; return runPipeline(gray, w, h, factor, despeckleNative, holeNative);');
      const gray = mkGray(nativeSize, nativeSize);
      const t0 = performance.now();
      try {
        const result = runPipelineFn(gray, nativeSize, nativeSize, effectiveFactor, despeckleNative, holeNative);
        const total = performance.now() - t0;
        return { outcome: 'success', totalMs: +total.toFixed(2), timings: result.timings, outputW: result.width, outputH: result.height };
      } catch (err) {
        return { outcome: 'error', error: String(err && err.message || err), totalMs: +(performance.now() - t0).toFixed(2) };
      }
    },
    { nativeSize, effectiveFactor, despeckleNative: DESPECKLE_NATIVE, holeNative: HOLE_NATIVE, pipelineSrc: PIPELINE_SRC, makeGraySrc: makeSourceInPage() }
  ).then(r => ({ ...r, effectiveFactor: +effectiveFactor.toFixed(3), requestedFactor: factor }));
}

async function withFreshPage(browser, fn) {
  // Each cell gets its own page so a crash in one cell can't corrupt the
  // next cell's measurement — mirrors #30's profile script reloading after
  // a crash, but proactively (fresh context per cell) since we're
  // deliberately probing the exact OOM boundary this session.
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  let crashed = false;
  page.on('crash', () => { crashed = true; });
  try {
    await page.goto(BASE_URL, { timeout: 30000 });
  } catch (err) {
    return { outcome: 'page-load-failed', error: String(err && err.message || err), crashed };
  }
  let result;
  try {
    result = await fn(page);
  } catch (err) {
    result = { outcome: crashed ? 'page-crashed' : 'evaluate-threw', error: String(err && err.message || err) };
  }
  if (crashed && result && result.outcome !== 'page-crashed') {
    result.crashedAfter = true;
  }
  try { await page.close({ runBeforeUnload: false }); } catch (_) { /* already dead */ }
  return result;
}

async function main() {
  const browser = await chromium.launch();
  const results = { worker: [], capped: [] };

  // ── Part A: Worker offload, same grid as #30 (including the two OOM
  // cells: 4200 @ 2x, 4200 @ 4x) ──────────────────────────────────────────
  console.log('\n\n########## PART A: Web Worker offload ##########');
  for (const nativeSize of NATIVE_SIZES) {
    for (const factor of FACTORS) {
      const label = `${nativeSize}x${nativeSize} @ ${factor}x (worker)`;
      console.log(`\n=== ${label} ===`);
      const r = await withFreshPage(browser, (page) => runWorkerTest(page, { nativeSize, factor }));
      console.log(JSON.stringify(r, null, 2));
      results.worker.push({ nativeSize, factor, ...r });
    }
  }

  // ── Part B: Capped effective supersample factor, same grid, testing two
  // candidate ceilings: a conservative one (2048, same ballpark as the
  // largest cell that did NOT crash at factor 2 in #30 — 2048@2x was
  // 577ms) and a more generous one (4096) to see how much headroom it
  // buys before the cap collapses to ~1x. ──────────────────────────────
  console.log('\n\n########## PART B: capped effective supersample factor ##########');
  for (const outputCap of [2048, 4096]) {
    for (const nativeSize of NATIVE_SIZES) {
      for (const factor of FACTORS) {
        const label = `${nativeSize}x${nativeSize} @ requested ${factor}x, cap=${outputCap}`;
        console.log(`\n=== ${label} ===`);
        const r = await withFreshPage(browser, (page) => runCappedTest(page, { nativeSize, factor, outputCap }));
        console.log(JSON.stringify(r, null, 2));
        results.capped.push({ nativeSize, factor, outputCap, ...r });
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();

  console.log('\n\n=== SUMMARY: Worker offload ===');
  console.log('size'.padEnd(14), 'factor'.padEnd(8), 'outcome'.padEnd(24), 'wallMs'.padEnd(10), 'error');
  for (const r of results.worker) {
    console.log(
      `${r.nativeSize}x${r.nativeSize}`.padEnd(14),
      `${r.factor}x`.padEnd(8),
      String(r.outcome).padEnd(24),
      String(r.wallMs ?? '—').padEnd(10),
      (r.error || '').slice(0, 60)
    );
  }

  console.log('\n=== SUMMARY: Capped effective factor ===');
  console.log('size'.padEnd(14), 'req'.padEnd(6), 'cap'.padEnd(6), 'effFactor'.padEnd(10), 'outcome'.padEnd(12), 'totalMs'.padEnd(10), 'outputRes');
  for (const r of results.capped) {
    console.log(
      `${r.nativeSize}x${r.nativeSize}`.padEnd(14),
      `${r.factor}x`.padEnd(6),
      String(r.outputCap).padEnd(6),
      String(r.effectiveFactor).padEnd(10),
      String(r.outcome).padEnd(12),
      String(r.totalMs ?? '—').padEnd(10),
      r.outputW ? `${r.outputW}x${r.outputH}` : ''
    );
  }
  console.log('\nDone. Output in', OUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
