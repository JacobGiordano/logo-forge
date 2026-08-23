// Performance-profiling spike for issue #30 (productionizing #27's
// bilinear-presupersample finding). #27's spike only measured pixel-diff
// quality at synthetic shapes up to 960x960 (240 native x 4). This script
// measures WALL-CLOCK COST at realistic production upload sizes, in-browser
// (main thread, exactly where this code would run in the real app — no
// worker exists in this codebase today, see js/app.js), for two things the
// findings doc explicitly flagged as unmeasured:
//
//   1. The bilinear-upsample-then-Otsu step itself, at native sizes well
//      beyond #27's 240x240 synthetic shapes (real uploads have no size cap
//      in this app today — confirmed by reading js/app.js's handleFile,
//      there is no MAX_DIM/resize step before canvas.getImageData).
//   2. The follow-on cost of moving despeckle/hole-fill/corner-smoothing
//      (removeSmallComponents/fillSmallHoles/smoothMask+morphMask in
//      js/app.js) from where they run TODAY (on the small native-resolution
//      mask, before Scale2x) to running on the LARGE upsampled mask instead
//      — which pipeline composition analysis (issue #30 part 3) concludes
//      they'd have to do if bilinear-presupersample replaces the
//      Otsu-then-Scale2x order, since a continuous luminance field has no
//      "small connected component" concept prior to thresholding.
//
// This is read-only profiling — no js/app.js changes. All mask/Otsu/
// despeckle/hole-fill/smoothing code below is copied near-verbatim from
// js/app.js (same algorithms, same defaults) purely to measure cost in
// isolation; see that file for the real implementations.
//
// Usage: node _system/potrace-spike/profile-bilinear-perf.mjs
// Requires a dev server already running; set BASE_URL below to match.
// Outputs: printed table + _system/potrace-spike/out-30-perf/profile.json
// (gitignored via the existing out-*/ pattern).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out-30-perf');
fs.mkdirSync(OUT, { recursive: true });
const BASE_URL = 'http://localhost:4322';

// Realistic native upload sizes: a small icon/favicon-source upload, a
// typical exported logo, a large logo/poster export, and a "user uploaded a
// full-res phone photo of a sign/business card by mistake" edge case — this
// app places no size cap on uploads today, so the last two are not
// hypothetical, they're what happens if a user picks the wrong file.
const NATIVE_SIZES = [512, 1024, 2048, 3000, 4200];
const FACTORS = [2, 4];

// Slider defaults from index.html (despeckle=24, hole-preservation=12,
// corner-smoothing=1), native-resolution mask-pixel units as documented in
// preprocessImageData's comment in js/app.js.
const DESPECKLE_NATIVE = 24;
const HOLE_NATIVE = 12;

async function profileInPage(page, { nativeSize, factor }) {
  return page.evaluate(
    ({ nativeSize, factor, despeckleNative, holeNative }) => {
      function now() { return performance.now(); }

      // ── Synthetic source: flat shape + coarse per-pixel noise, closer to
      // a real noisy/scanned upload than #25/#27's clean vector shapes (this
      // script only measures TIMING, not fidelity, so exact content doesn't
      // matter — only that it's a plausible w x h RGBA buffer with a
      // realistic bimodal-ish histogram so Otsu/despeckle do real work
      // rather than optimizing away on an all-one-value buffer).
      function makeSource(w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(w * 0.5, h * 0.5, Math.min(w, h) * 0.35, 0, Math.PI * 2);
        ctx.fill();
        const id = ctx.getImageData(0, 0, w, h);
        // sprinkle speckle noise so despeckle/hole-fill have real work to do
        for (let i = 0; i < id.data.length; i += 4) {
          if (Math.random() < 0.002) {
            const v = Math.random() < 0.5 ? 0 : 255;
            id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
          }
        }
        ctx.putImageData(id, 0, 0);
        return id;
      }

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

      // ── (a) TODAY'S production order at this size, no upscale: native
      // Otsu + despeckle + hole-fill on the small native mask. This is the
      // "cheap because it operates on the small array" baseline.
      const src = makeSource(nativeSize, nativeSize);
      const lumInt = new Uint8Array(nativeSize * nativeSize);
      const hist = new Uint32Array(256);
      let t0 = now();
      for (let i = 0, px = 0; i < src.data.length; i += 4, px++) {
        const a = src.data[i + 3] / 255;
        const lum = (src.data[i] * 0.299 + src.data[i + 1] * 0.587 + src.data[i + 2] * 0.114) * a + 255 * (1 - a);
        const r = Math.max(0, Math.min(255, Math.round(lum)));
        lumInt[px] = r; hist[r]++;
      }
      const otsuNative = computeOtsuThreshold(hist, lumInt.length);
      const tLumNative = now() - t0;

      t0 = now();
      const maskNative = new Uint8Array(nativeSize * nativeSize);
      for (let i = 0; i < lumInt.length; i++) maskNative[i] = lumInt[i] < otsuNative ? 1 : 0;
      const tBinNative = now() - t0;

      t0 = now();
      let cleanedNative = removeSmallComponents(maskNative, nativeSize, nativeSize, despeckleNative);
      const tDespeckleNative = now() - t0;

      t0 = now();
      cleanedNative = fillSmallHoles(cleanedNative, nativeSize, nativeSize, holeNative);
      const tHoleNative = now() - t0;

      // ── (b) Scale2x-family upscale of the ALREADY-cleaned native mask
      // (today's production order) to `factor`x, for comparison.
      function at(s, w, h, x, y) {
        if (x < 0) x = 0; else if (x >= w) x = w - 1;
        if (y < 0) y = 0; else if (y >= h) y = h - 1;
        return s[y * w + x];
      }
      function scale2x(s, w, h) {
        const dw = w * 2, dh = h * 2;
        const d = new Uint8Array(dw * dh);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const E = at(s, w, h, x, y), B = at(s, w, h, x, y - 1), D = at(s, w, h, x - 1, y),
            F = at(s, w, h, x + 1, y), H = at(s, w, h, x, y + 1);
          let E0 = E, E1 = E, E2 = E, E3 = E;
          if (B !== H && D !== F) {
            E0 = D === B ? D : E; E1 = B === F ? F : E; E2 = D === H ? D : E; E3 = H === F ? F : E;
          }
          const ox = x * 2, oy = y * 2;
          d[oy * dw + ox] = E0; d[oy * dw + ox + 1] = E1; d[(oy + 1) * dw + ox] = E2; d[(oy + 1) * dw + ox + 1] = E3;
        }
        return { data: d, width: dw, height: dh };
      }
      t0 = now();
      let sc = { data: cleanedNative, width: nativeSize, height: nativeSize };
      const s2Passes = factor === 4 ? 2 : 1; // matches upscale.js's factor:4 = scale2x twice
      for (let p = 0; p < s2Passes; p++) sc = scale2x(sc.data, sc.width, sc.height);
      const tScale2x = now() - t0;

      // ── (c) Candidate bilinear-presupersample order: continuous
      // luminance -> bilinear upsample by `factor` -> Otsu AT upsampled res
      // -> despeckle/hole-fill AT upsampled res with factor^2-scaled
      // maxArea (the factor-aware scaling issue #30 part 3 asks about).
      const lumFloat = new Float64Array(nativeSize * nativeSize);
      for (let i = 0, px = 0; i < src.data.length; i += 4, px++) {
        const a = src.data[i + 3] / 255;
        lumFloat[px] = (src.data[i] * 0.299 + src.data[i + 1] * 0.587 + src.data[i + 2] * 0.114) * a + 255 * (1 - a);
      }

      const w = nativeSize, h = nativeSize, ow = w * factor, oh = h * factor;
      let upMemFail = null;
      let tBilinear = null, tOtsuUp = null, tBinUp = null, tDespeckleUp = null, tHoleUp = null;
      let maskUpLen = null;
      try {
        t0 = now();
        const up = new Float64Array(ow * oh);
        for (let oy = 0; oy < oh; oy++) {
          let iy = (oy + 0.5) / factor - 0.5;
          if (iy < 0) iy = 0; if (iy > h - 1) iy = h - 1;
          const y0 = Math.floor(iy), y1 = Math.min(y0 + 1, h - 1), fy = iy - y0;
          for (let ox = 0; ox < ow; ox++) {
            let ix = (ox + 0.5) / factor - 0.5;
            if (ix < 0) ix = 0; if (ix > w - 1) ix = w - 1;
            const x0 = Math.floor(ix), x1 = Math.min(x0 + 1, w - 1), fx = ix - x0;
            const v00 = lumFloat[y0 * w + x0], v10 = lumFloat[y0 * w + x1];
            const v01 = lumFloat[y1 * w + x0], v11 = lumFloat[y1 * w + x1];
            const top = v00 * (1 - fx) + v10 * fx;
            const bot = v01 * (1 - fx) + v11 * fx;
            up[oy * ow + ox] = top * (1 - fy) + bot * fy;
          }
        }
        tBilinear = now() - t0;

        t0 = now();
        const histUp = new Uint32Array(256);
        for (let i = 0; i < up.length; i++) histUp[Math.max(0, Math.min(255, Math.round(up[i])))]++;
        const otsuUp = computeOtsuThreshold(histUp, up.length);
        tOtsuUp = now() - t0;

        t0 = now();
        const maskUp = new Uint8Array(ow * oh);
        for (let i = 0; i < up.length; i++) maskUp[i] = up[i] < otsuUp ? 1 : 0;
        tBinUp = now() - t0;
        maskUpLen = maskUp.length;

        const factorAreaScale = factor * factor;
        t0 = now();
        let cleanedUp = removeSmallComponents(maskUp, ow, oh, despeckleNative * factorAreaScale);
        tDespeckleUp = now() - t0;

        t0 = now();
        cleanedUp = fillSmallHoles(cleanedUp, ow, oh, holeNative * factorAreaScale);
        tHoleUp = now() - t0;
      } catch (e) {
        upMemFail = String(e && e.message || e);
      }

      return {
        nativeSize, factor,
        native: {
          otsu: otsuNative,
          tLuminance: +tLumNative.toFixed(2),
          tBinarize: +tBinNative.toFixed(2),
          tDespeckle: +tDespeckleNative.toFixed(2),
          tHoleFill: +tHoleNative.toFixed(2),
          tScale2xUpscale: +tScale2x.toFixed(2),
          totalMs: +(tLumNative + tBinNative + tDespeckleNative + tHoleNative + tScale2x).toFixed(2),
        },
        bilinear: upMemFail ? { error: upMemFail } : {
          upsampledPixels: maskUpLen,
          tBilinearUpsample: +tBilinear.toFixed(2),
          tOtsu: +tOtsuUp.toFixed(2),
          tBinarize: +tBinUp.toFixed(2),
          tDespeckle: +tDespeckleUp.toFixed(2),
          tHoleFill: +tHoleUp.toFixed(2),
          totalMs: +(tBilinear + tOtsuUp + tBinUp + tDespeckleUp + tHoleUp).toFixed(2),
        },
      };
    },
    { nativeSize, factor, despeckleNative: DESPECKLE_NATIVE, holeNative: HOLE_NATIVE }
  );
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(BASE_URL);

  const results = [];
  for (const nativeSize of NATIVE_SIZES) {
    for (const factor of FACTORS) {
      const label = `${nativeSize}x${nativeSize} @ ${factor}x -> ${nativeSize * factor}x${nativeSize * factor}`;
      console.log(`\n=== ${label} ===`);
      let r;
      try {
        r = await profileInPage(page, { nativeSize, factor });
      } catch (e) {
        r = { nativeSize, factor, error: String(e && e.message || e) };
        console.log('CRASHED/ERRORED:', r.error);
        // page likely crashed (OOM) — reload before continuing
        try { await page.goto(BASE_URL); } catch (_) { /* browser may be dead */ }
      }
      console.log(JSON.stringify(r, null, 2));
      results.push(r);
    }
  }

  fs.writeFileSync(path.join(OUT, 'profile.json'), JSON.stringify(results, null, 2));
  await browser.close();

  console.log('\n\n=== SUMMARY TABLE (total pipeline ms: native+Scale2x vs bilinear-presupersample) ===');
  console.log('size'.padEnd(22), 'factor'.padEnd(8), 'native+Scale2x'.padEnd(16), 'bilinear-presupersample'.padEnd(24), 'ratio');
  for (const r of results) {
    if (r.error || r.bilinear?.error) {
      console.log(String(r.nativeSize).padEnd(22), String(r.factor).padEnd(8), '—'.padEnd(16), (r.error || r.bilinear.error).slice(0, 60));
      continue;
    }
    const a = r.native.totalMs, b = r.bilinear.totalMs;
    console.log(
      `${r.nativeSize}x${r.nativeSize}`.padEnd(22),
      `${r.factor}x`.padEnd(8),
      `${a}ms`.padEnd(16),
      `${b}ms`.padEnd(24),
      `${(b / a).toFixed(1)}x`
    );
  }
  console.log('\nDone. Output in', OUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
