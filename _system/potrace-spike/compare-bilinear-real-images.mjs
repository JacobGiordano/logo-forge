// Real-image (non-synthetic-clean) validation for issue #30, part 1.
// #25/#27 both deliberately used clean, noise-free vector-drawn synthetic
// shapes to isolate the mechanism under test from source-quality confounds
// (see #25's findings doc rationale, reused verbatim by #27). Issue #30
// explicitly asks the productionization work to check whether #27's win
// holds up on realistic degraded input: scan noise, JPG artifacts,
// anti-aliased screenshot/font content — which #27 never tested.
//
// This harness reuses #27's exact shape generators and ground-truth/diff
// methodology (compare-bilinear-presupersample.mjs, same file) but traces a
// DEGRADED version of each source (JPEG re-encode + salt noise, or native
// font anti-aliasing) instead of the clean vector-drawn source, while
// diffing against the SAME clean 4x ground truth #27 used — this isolates
// "does degraded input change which mechanism wins" from "what does clean
// input look like," which is what #27 already answered.
//
// Also exercises the tests/fixtures/select-sheet-aa.png fixture (a real,
// already-anti-aliased PNG committed to the repo) as a third case with no
// synthetic degradation and no ground truth available — read-only use, this
// script does not modify anything under tests/.
//
// Unlike #27, this harness ALSO applies despeckle/hole-fill at the upsampled
// resolution with factor^2-scaled maxArea thresholds (issue #30 part 3's
// proposed composition) to the bilinear candidate, since noisy/real content
// is exactly the case where skipping despeckle (as #27 did, safe only for
// clean synthetic shapes) would matter.
//
// Usage: node _system/potrace-spike/compare-bilinear-real-images.mjs
// Requires a dev server already running; BASE_URL below must match.
// Outputs: _system/potrace-spike/out-30-real/ (gitignored, not committed).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out-30-real');
fs.mkdirSync(OUT, { recursive: true });
const BASE_URL = 'http://localhost:4322';
const FIXTURE_AA = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'select-sheet-aa.png');

// 240, not 256+ — images above SELECT_SKIP_MAX_DIM (256, js/app.js) route
// through the selection-view UI first, which this harness doesn't drive;
// 240 matches #25/#27's convention for the same reason and keeps this
// directly comparable to their numbers.
const WORK_SIZE = 240;
const GT_SIZE = 960; // 4x, same convention as #27

const TIGHT = { alphamax: 0.35, opttolerance: 0.05 };
const PRODUCTION_LIKE = {
  turnpolicy: 4, opticurve: 1, pathonly: false,
  extractcolors: true, posterizelevel: 2, posterizationalgorithm: 0,
  ...TIGHT,
};
const DESPECKLE_NATIVE = 24;   // slider default, native-resolution mask-pixel units
const HOLE_NATIVE = 12;

// ── Degraded-source generators (JPEG artifacts + noise) ────────────────────
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

      // clean, at working size — used both as the tracer's un-degraded
      // reference and as the base for degradation below
      const clean = document.createElement('canvas');
      clean.width = size; clean.height = size;
      drawClean(clean.getContext('2d'), size);
      const cleanDataUrl = clean.toDataURL('image/png');

      // degrade: round-trip through low-quality JPEG (blocking/ringing
      // artifacts), then sprinkle salt noise (scan-noise proxy)
      const jpegUrl = clean.toDataURL('image/jpeg', 0.35);
      return { cleanDataUrl, jpegUrl };
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
      // deterministic-ish salt noise: ~0.8% of pixels flipped toward black
      // or white, simulating scan/sensor speckle on top of JPEG blocking
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

// ── Drive the real app (baseline A) ─────────────────────────────────────
async function uploadAndTrace(page, filePath, { upscaleFactor } = {}) {
  await page.locator('#file-input').setInputFiles(filePath);
  await page.locator('#trace-btn').waitFor({ state: 'visible' });
  await page.locator('#trace-btn').isEnabled({ timeout: 5000 });
  if (upscaleFactor) {
    await page.locator('#upscale-factor').selectOption(String(upscaleFactor));
  } else {
    await page.locator('#upscale-factor').selectOption('1');
  }
  await page.locator('#trace-btn').click();
  await page.locator('#status').filter({ hasText: 'Done' }).waitFor({ timeout: 30000 });
  return page.evaluate(() => {
    const svg = document.querySelector('.prev-card-body.on-light')?.innerHTML || null;
    const metaText = document.getElementById('svg-meta')?.innerText || '';
    const num = re => { const m = metaText.match(re); return m ? Number(m[1]) : null; };
    return {
      svg,
      stats: {
        pathCount: num(/Paths:\s*(\d+)/),
        holeCount: num(/Holes:\s*(\d+)/),
        byteSizeKB: num(/Size:\s*([\d.]+)\s*KB/),
      },
    };
  });
}

async function loadPotrace(page) {
  await page.evaluate(async () => {
    if (window.__potraceMod) return;
    const mod = await import('/js/potrace-wasm.js');
    await mod.init();
    window.__potraceMod = mod;
  });
}

// Bilinear-then-threshold candidate, EXTENDED from #27's version to also
// apply despeckle/hole-fill at the upsampled resolution with
// factor^2-scaled maxArea (issue #30 part 3's proposed composition) — #27
// deliberately skipped this since its shapes were noise-free; real/degraded
// content is exactly the case that needs it.
async function buildBilinearMask(page, dataUrl, factor, { despeckleNative, holeNative }) {
  return page.evaluate(
    async ({ dataUrl, factor, despeckleNative, holeNative }) => {
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

      // ── despeckle + hole-fill AT upsampled resolution, factor^2-scaled
      // area thresholds (part 3's proposed composition)
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

      const factorAreaScale = factor * factor;
      mask = removeSmallComponents(mask, ow, oh, despeckleNative * factorAreaScale);
      mask = fillSmallHoles(mask, ow, oh, holeNative * factorAreaScale);

      const maskImg = new Uint8ClampedArray(ow * oh * 4);
      for (let i = 0; i < mask.length; i++) {
        const v = mask[i] ? 0 : 255;
        const idx = i * 4;
        maskImg[idx] = v; maskImg[idx + 1] = v; maskImg[idx + 2] = v; maskImg[idx + 3] = 255;
      }
      const outCanvas = document.createElement('canvas');
      outCanvas.width = ow; outCanvas.height = oh;
      outCanvas.getContext('2d').putImageData(new ImageData(maskImg, ow, oh), 0, 0);
      return { dataUrl: outCanvas.toDataURL('image/png'), width: ow, height: oh, threshold };
    },
    { dataUrl, factor, despeckleNative, holeNative }
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

async function renderSvgToPng(page, svgStr, outPath, size = 480) {
  await page.evaluate(
    ({ svgStr, size }) => {
      let holder = document.getElementById('__spike_render_holder');
      if (!holder) {
        holder = document.createElement('div');
        holder.id = '__spike_render_holder';
        holder.style.position = 'fixed'; holder.style.top = '0'; holder.style.left = '0';
        holder.style.background = '#fff'; holder.style.zIndex = '99999';
        document.body.appendChild(holder);
      }
      holder.innerHTML = '';
      const img = document.createElement('img');
      img.id = '__spike_render_img';
      img.style.width = size + 'px'; img.style.height = size + 'px'; img.style.display = 'block';
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
      holder.appendChild(img);
    },
    { svgStr, size }
  );
  const img = page.locator('#__spike_render_img');
  await img.waitFor({ state: 'visible' });
  await page.waitForTimeout(50);
  await img.screenshot({ path: outPath });
}

async function fileToDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function dataUrlToFile(dataUrl, outPath) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(outPath, buf);
  return outPath;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(BASE_URL);
  await loadPotrace(page);

  const summary = {};

  // ── Cases with a clean ground truth: degrade, then trace the degraded
  // source, diff against the CLEAN shape's native 4x render (same
  // methodology as #27, but the traced input is now degraded).
  for (const kind of ['noisy-logo', 'aa-wordmark']) {
    console.log(`\n=== Case: ${kind} (degraded source, clean ground truth) ===`);
    const caseOut = {};

    const { cleanDataUrl, jpegUrl } = await makeDegradedSource(page, kind, WORK_SIZE);
    const degradedDataUrl = await jpegToNoisyPng(page, jpegUrl, WORK_SIZE);
    const degradedFile = await dataUrlToFile(degradedDataUrl, path.join(OUT, `${kind}__0-degraded-source.png`));
    await dataUrlToFile(cleanDataUrl, path.join(OUT, `${kind}__0-clean-source.png`));

    // clean ground truth at 4x, drawn natively (never upscaled from the
    // small bitmap) — same shape generator, just called at GT_SIZE
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

    // A1) app default, degraded source, upscale off
    const appDefault = await uploadAndTrace(page, degradedFile, { upscaleFactor: 1 });
    const appDefaultDiff = await pixelDiffAgainstGroundTruth(page, appDefault.svg, gtDataUrl, GT_SIZE);
    await renderSvgToPng(page, appDefault.svg, path.join(OUT, `${kind}__A1-app-default.png`));
    caseOut.appDefault = { stats: appDefault.stats, diff: appDefaultDiff };
    console.log('A1) app baseline (upscale off), degraded source:', caseOut.appDefault);

    // A2) app Scale2x-4x, degraded source, matched resolution
    const appUp4 = await uploadAndTrace(page, degradedFile, { upscaleFactor: 4 });
    const appUp4Diff = await pixelDiffAgainstGroundTruth(page, appUp4.svg, gtDataUrl, GT_SIZE);
    await renderSvgToPng(page, appUp4.svg, path.join(OUT, `${kind}__A2-app-scale2x-4x.png`));
    caseOut.appScale2x4x = { stats: appUp4.stats, diff: appUp4Diff };
    console.log('A2) app baseline (Scale2x 4x), degraded source:', caseOut.appScale2x4x);

    // C) bilinear-presupersample + despeckle/hole-fill at upsampled res,
    // degraded source, factor 2 and 4
    for (const factor of [2, 4]) {
      const mask = await buildBilinearMask(page, degradedDataUrl, factor, {
        despeckleNative: DESPECKLE_NATIVE, holeNative: HOLE_NATIVE,
      });
      const result = await runPotrace(page, mask.dataUrl, { turdsize: 0, ...PRODUCTION_LIKE });
      const fragCount = result.paths.filter(p => p.dLength < 100).length;
      const collapsed = await collapsedMergeSvg(page, result.svg, mask.width, mask.height);
      const diff = await pixelDiffAgainstGroundTruth(page, collapsed, gtDataUrl, GT_SIZE);
      const key = `C-bilinear-F${factor}`;
      caseOut[key] = {
        otsuThreshold: mask.threshold,
        pathCount: result.paths.length,
        fragCount,
        fragPct: result.paths.length ? +(100 * fragCount / result.paths.length).toFixed(1) : 0,
        collapsedBytes: collapsed.length,
        diff,
        ms: result.ms,
      };
      console.log(`C) bilinear F=${factor} + despeckle/hole-fill @ upsampled res, degraded source:`, caseOut[key]);
      await renderSvgToPng(page, collapsed, path.join(OUT, `${kind}__C-bilinear-F${factor}.png`));
      fs.writeFileSync(path.join(OUT, `${kind}__C-bilinear-F${factor}-mask.png`),
        Buffer.from(mask.dataUrl.split(',')[1], 'base64'));
    }

    summary[kind] = caseOut;
  }

  // ── Real fixture, no synthetic degradation, no ground truth (report
  // fragmentation/size only) ────────────────────────────────────────────
  console.log(`\n=== Case: select-sheet-aa (real fixture, no ground truth) ===`);
  // 512x512 — above SELECT_SKIP_MAX_DIM (256), so it routes through the
  // selection-view UI this harness doesn't drive. App-baseline (A1/A2) rows
  // are skipped for this case; the bilinear candidate below bypasses the UI
  // entirely (direct potrace-wasm call, same as #27's C configuration) so
  // it's unaffected.
  const caseOut = { appDefault: 'skipped (512x512 routes through selection-view UI)', appScale2x4x: 'skipped' };
  const fixtureDataUrl = await fileToDataUrl(FIXTURE_AA);

  for (const factor of [2, 4]) {
    const mask = await buildBilinearMask(page, fixtureDataUrl, factor, {
      despeckleNative: DESPECKLE_NATIVE, holeNative: HOLE_NATIVE,
    });
    const result = await runPotrace(page, mask.dataUrl, { turdsize: 0, ...PRODUCTION_LIKE });
    const fragCount = result.paths.filter(p => p.dLength < 100).length;
    const collapsed = await collapsedMergeSvg(page, result.svg, mask.width, mask.height);
    const key = `C-bilinear-F${factor}`;
    caseOut[key] = {
      otsuThreshold: mask.threshold, pathCount: result.paths.length, fragCount,
      fragPct: result.paths.length ? +(100 * fragCount / result.paths.length).toFixed(1) : 0,
      collapsedBytes: collapsed.length, ms: result.ms,
    };
    console.log(`C) bilinear F=${factor} + despeckle/hole-fill @ upsampled res:`, caseOut[key]);
    await renderSvgToPng(page, collapsed, path.join(OUT, `select-sheet-aa__C-bilinear-F${factor}.png`));
  }
  summary['select-sheet-aa'] = caseOut;

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  await browser.close();
  console.log('\nDone. Output in', OUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
