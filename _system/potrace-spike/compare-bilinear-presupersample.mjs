// Throwaway spike harness for issue #27 — investigates whether bilinear
// (true, continuous) supersampling of grayscale luminance data BEFORE the
// Otsu threshold beats today's production pipeline (Otsu threshold ->
// despeckle/hole-fill -> Scale2x-family pixel-art upscale, js/upscale.js,
// POST-binarize). Same ground-truth pixel-diff methodology as #25's
// compare-antialiased-edges.mjs (same file layout, same helper functions,
// same three synthetic shapes for direct comparability) — extended with a
// bilinear-before-threshold configuration #25 flagged but did not test.
//
// Usage: node _system/potrace-spike/compare-bilinear-presupersample.mjs
// Requires: `npx serve . -l 4321` already running.
// Outputs land in _system/potrace-spike/out-27/ (gitignored, not committed).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out-27');
fs.mkdirSync(OUT, { recursive: true });
// NOTE: not the conventional 4321 — this worktree's dev server landed on a
// different port because another concurrent agent's worktree already had
// 4321 bound (see console output of `npx serve . -l 4321` in this session).
// Regenerate: start `npx serve . -l 0` (or check whichever port is free) and
// update this constant, or just always run `npx serve .` and read the port
// it prints.
const BASE_URL = 'http://localhost:40435';

// ── Synthetic test shapes ───────────────────────────────────────────────
// Identical generators to #25's compare-antialiased-edges.mjs (same names,
// same geometry) so this spike's numbers are directly comparable to #25's
// table without introducing a new confound. See #25's findings doc for the
// rationale of each shape (geometric/flat-color, detailed/curved, topology).
const SHAPES = {
  'geo-star': (s) => `
    const c = document.createElement('canvas');
    c.width = ${s}; c.height = ${s};
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,${s},${s});
    ctx.fillStyle = '#000';
    ctx.beginPath();
    const cx=${s}/2, cy=${s}/2, rOuter=${s}*0.42, rInner=${s}*0.17, spikes=6;
    for (let i=0;i<spikes*2;i++){
      const r = i%2===0 ? rOuter : rInner;
      const a = (Math.PI/spikes)*i - Math.PI/2;
      const x = cx + r*Math.cos(a), y = cy + r*Math.sin(a);
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.fill();
    return c.toDataURL('image/png');
  `,
  'curved-icon': (s) => `
    const c = document.createElement('canvas');
    c.width = ${s}; c.height = ${s};
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,${s},${s});
    ctx.fillStyle = '#000';
    ctx.beginPath();
    const cx=${s}*0.42, cy=${s}*0.42, r=${s}*0.28;
    ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.fill();
    ctx.lineWidth = ${s}*0.045;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + r*0.75, cy + r*0.75);
    ctx.quadraticCurveTo(${s}*0.75, ${s}*0.75, ${s}*0.88, ${s}*0.9);
    ctx.stroke();
    return c.toDataURL('image/png');
  `,
  'ring-holes': (s) => `
    const c = document.createElement('canvas');
    c.width = ${s}; c.height = ${s};
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,${s},${s});
    ctx.fillStyle = '#000';
    const cx=${s}/2, cy=${s}/2;
    ctx.beginPath();
    ctx.arc(cx,cy,${s}*0.42,0,Math.PI*2);
    ctx.arc(cx,cy,${s}*0.27,0,Math.PI*2,true);
    ctx.fill('evenodd');
    ctx.beginPath();
    ctx.arc(cx,cy,${s}*0.13,0,Math.PI*2);
    ctx.fill();
    return c.toDataURL('image/png');
  `,
};

async function drawShape(page, kind, size) {
  const dataUrl = await page.evaluate(new Function(SHAPES[kind](size)));
  return dataUrl;
}

async function dataUrlToFile(dataUrl, outPath) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(outPath, buf);
  return outPath;
}

// ── Drive the real app (baseline A) ─────────────────────────────────────
async function uploadAndTrace(page, filePath, { upscaleFactor } = {}) {
  await page.locator('#file-input').setInputFiles(filePath);
  await page.locator('#trace-btn').waitFor({ state: 'visible' });
  await page.locator('#trace-btn').isEnabled({ timeout: 5000 });
  if (upscaleFactor) {
    await page.locator('#upscale-factor').selectOption(String(upscaleFactor));
  }
  await page.locator('#trace-btn').click();
  await page.locator('#status').filter({ hasText: 'Done' }).waitFor({ timeout: 20000 });

  return page.evaluate(() => {
    const svg = document.querySelector('.prev-card-body.on-light')?.innerHTML || null;
    const metaText = document.getElementById('svg-meta')?.innerText || '';
    const num = re => {
      const m = metaText.match(re);
      return m ? Number(m[1]) : null;
    };
    const engineMatch = metaText.match(/Engine:\s*(\S+)/);
    return {
      svg,
      stats: {
        pathCount: num(/Paths:\s*(\d+)/),
        holeCount: num(/Holes:\s*(\d+)/),
        byteSizeKB: num(/Size:\s*([\d.]+)\s*KB/),
        engine: engineMatch ? engineMatch[1] : null,
      },
    };
  });
}

// ── Direct potrace-wasm calls (bypass UI — no toggle exists for the
// bilinear-pre-threshold experiment) ─────────────────────────────────────
async function loadPotrace(page) {
  await page.evaluate(async () => {
    if (window.__potraceMod) return;
    const mod = await import('/js/potrace-wasm.js');
    await mod.init();
    window.__potraceMod = mod;
  });
}

// Builds a binary (2-color) mask by: (1) computing the CONTINUOUS
// (unrounded) grayscale luminance of the source at its native working
// resolution, replicating preprocessImageData's exact math (0.299/0.587/
// 0.114, alpha-composited onto white — js/app.js) but WITHOUT the
// Math.round()/Uint8Array quantization step preprocessImageData applies
// before Otsu — rounding first would itself throw away the sub-pixel
// precision this spike is trying to preserve, defeating the point; (2)
// bilinear-interpolating that continuous luminance field up by `factor`
// (manual bilinear resampler, not canvas drawImage — canvas's upscale
// filter quality is implementation-defined across browsers/versions, manual
// bilinear keeps the algorithm under test precisely specified and
// reproducible); (3) computing Otsu's threshold and binarizing AT the
// upsampled resolution (issue #27's literal ask: "then binarize at the
// higher resolution", i.e. supersample-then-threshold, the inverse order of
// today's threshold-then-Scale2x-upscale production pipeline). No
// despeckle/hole-fill/corner-smoothing emulation — #25's harness didn't
// emulate those either for its synthetic (noise-free) shapes; turdsize is
// swept on potrace's side below to test its own despeckle knob, matching
// #25's approach.
async function buildBilinearThresholdMask(page, dataUrl, factor) {
  return page.evaluate(
    async ({ dataUrl, factor }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const src = ctx.getImageData(0, 0, w, h);

      // (1) continuous luminance, no rounding
      const lum = new Float64Array(w * h);
      for (let i = 0, px = 0; i < src.data.length; i += 4, px++) {
        const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2], a = src.data[i + 3] / 255;
        lum[px] = (r * 0.299 + g * 0.587 + b * 0.114) * a + 255 * (1 - a);
      }

      // (2) manual bilinear upsample of the continuous field
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

      // (3) Otsu threshold + binarize, computed AT the upsampled resolution
      const hist = new Uint32Array(256);
      for (let i = 0; i < up.length; i++) {
        hist[Math.max(0, Math.min(255, Math.round(up[i])))]++;
      }
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

      // mask=1 (dark/foreground) -> pixel 0 (black); mask=0 -> 255 (white).
      // Matches maskToImageData's convention in js/app.js exactly.
      const maskImg = new Uint8ClampedArray(ow * oh * 4);
      for (let i = 0; i < up.length; i++) {
        const dark = up[i] < threshold;
        const v = dark ? 0 : 255;
        const idx = i * 4;
        maskImg[idx] = v; maskImg[idx + 1] = v; maskImg[idx + 2] = v; maskImg[idx + 3] = 255;
      }
      const outCanvas = document.createElement('canvas');
      outCanvas.width = ow; outCanvas.height = oh;
      outCanvas.getContext('2d').putImageData(new ImageData(maskImg, ow, oh), 0, 0);
      return { dataUrl: outCanvas.toDataURL('image/png'), width: ow, height: oh, threshold };
    },
    { dataUrl, factor }
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
        while (n) {
          const f = n.getAttribute && n.getAttribute('fill');
          if (f) return f;
          n = n.parentElement;
        }
        return null;
      }
      const paths = Array.from(doc.querySelectorAll('path')).map(p => ({
        fill: effectiveFill(p),
        dLength: (p.getAttribute('d') || '').length,
      }));
      return { svg, paths, ms: t1 - t0 };
    },
    { dataUrl, options }
  );
}

// Collapses a raw potrace-wasm result to a single flat fill="#000000"
// evenodd path — mirrors #25's collapsedMergeSvg / this app's cleanupSVG.
// NECESSARY normalization discovered while running this spike: calling
// potrace-wasm directly (bypassing js/potrace-trace.js, same as #25's
// harness did for its B/C configurations) exposes potrace's raw
// extractcolors/posterizelevel:2 output, which does NOT reliably pick pure
// #000000/#ffffff even from a strictly-binary (0/255) input PNG — it picks
// a representative color from its own internal color-quantization pass
// (observed e.g. #2B2B2B on a mask with zero intermediate pixel values).
// The real app's production path applies its own cleanup pass (not
// exercised by a direct potrace-wasm call) that normalizes this; #25's own
// collapsedMergeSvg already did this same normalization for exactly this
// reason. Skipping it (as this file's first draft did) inflates diff% by
// ~40+ luma units across 100% of the shape's interior — a measurement
// artifact, not a real quality difference — since the >40 luma-delta pixel
// counter in pixelDiffAgainstGroundTruth then flags every "dark" interior
// pixel as different from ground truth's pure black, dwarfing genuine edge
// differences.
async function collapsedMergeSvg(page, rawSvg, width, height) {
  return page.evaluate(
    ({ rawSvg, width, height }) => {
      function effectiveFill(el) {
        let n = el;
        while (n) {
          const f = n.getAttribute && n.getAttribute('fill');
          if (f) return f;
          n = n.parentElement;
        }
        return null;
      }
      function effectiveTransform(el) {
        let n = el;
        while (n) {
          const t = n.getAttribute && n.getAttribute('transform');
          if (t) return t;
          n = n.parentElement;
        }
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

// ── Pixel-diff against a native-antialiased ground-truth render ─────────
// Identical to #25's implementation — same luma-delta/>40-threshold/RMSE
// methodology, so diff%/rmse numbers are directly comparable across spikes.
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
      let diffPixels = 0;
      let sqErr = 0;
      for (let i = 0; i < gt.data.length; i += 4) {
        const lumaA = gt.data[i] * 0.299 + gt.data[i + 1] * 0.587 + gt.data[i + 2] * 0.114;
        const lumaB = cand.data[i] * 0.299 + cand.data[i + 1] * 0.587 + cand.data[i + 2] * 0.114;
        const d = lumaA - lumaB;
        sqErr += d * d;
        if (Math.abs(d) > 40) diffPixels++;
      }
      const totalPixels = gt.data.length / 4;
      return {
        diffPixels,
        diffPct: +(100 * diffPixels / totalPixels).toFixed(3),
        rmse: +Math.sqrt(sqErr / totalPixels).toFixed(3),
      };
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
        holder.style.position = 'fixed';
        holder.style.top = '0';
        holder.style.left = '0';
        holder.style.background = '#fff';
        holder.style.zIndex = '99999';
        document.body.appendChild(holder);
      }
      holder.innerHTML = '';
      const img = document.createElement('img');
      img.id = '__spike_render_img';
      img.style.width = size + 'px';
      img.style.height = size + 'px';
      img.style.display = 'block';
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

// TIGHT alphamax/opttolerance held constant at #13/#16/#25's validated
// preset across every configuration in this spike — isolates the
// supersample-mechanism axis, not curve-fit tuning.
const TIGHT = { alphamax: 0.35, opttolerance: 0.05 };
const WORK_SIZE = 240;
const GT_SIZE = 960; // 4x working resolution, native-AA ground truth

// potrace-wasm options matching buildPotraceOptions() in js/app.js as
// closely as possible for the production-adjacent configurations (turdsize
// 0, matching production's "despeckle already handled upstream" rationale;
// posterizelevel 2 since every mask here — bilinear or Scale2x — is already
// flat 2-color, not multi-band).
const PRODUCTION_LIKE = {
  turnpolicy: 4, opticurve: 1, pathonly: false,
  extractcolors: true, posterizelevel: 2, posterizationalgorithm: 0,
  ...TIGHT,
};

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(BASE_URL);
  await loadPotrace(page);

  const summary = {};

  for (const kind of Object.keys(SHAPES)) {
    console.log(`\n=== Case: ${kind} ===`);
    const caseOut = {};

    const srcDataUrl = await drawShape(page, kind, WORK_SIZE);
    const srcFile = await dataUrlToFile(srcDataUrl, path.join(OUT, `${kind}__0-source.png`));
    const gtDataUrl = await drawShape(page, kind, GT_SIZE);
    fs.writeFileSync(
      path.join(OUT, `${kind}__gt-ground-truth.png`),
      Buffer.from(gtDataUrl.split(',')[1], 'base64')
    );

    // (A1) App baseline, default settings (upscale-factor "Off" = 1) — the
    // exact same configuration #25's app-baseline row used, for a sanity
    // cross-check that this harness reproduces #25's numbers on the same
    // shapes before trusting the new bilinear comparison below. Explicitly
    // reset upscale-factor to 1 first — the page/browser instance is reused
    // across all three shapes in this loop, so without an explicit reset
    // here, shape N's A1 would silently inherit shape N-1's A2 (upscale=4)
    // setting (caught during this spike's first run: curved-icon/ring-holes
    // A1 and A2 came back byte-identical because of exactly this leak).
    const appDefault = await uploadAndTrace(page, srcFile, { upscaleFactor: 1 });
    const appDefaultDiff = await pixelDiffAgainstGroundTruth(page, appDefault.svg, gtDataUrl, GT_SIZE);
    await renderSvgToPng(page, appDefault.svg, path.join(OUT, `${kind}__A1-app-default.png`));
    caseOut.appDefault = { stats: appDefault.stats, diff: appDefaultDiff };
    console.log('A1) app baseline (upscale off):', caseOut.appDefault);

    // (A2) App baseline, Scale2x-family upscale-factor forced to 4x — the
    // production pipeline's actual answer to "get more resolution before
    // tracing," run at the SAME final resolution (960x960) as the bilinear
    // 4x variant below and the 960x960 ground truth itself. This is the
    // apples-to-apples comparison the issue asks for: same final trace
    // resolution, different mechanism (post-binarize pattern-matched
    // upscale vs pre-binarize continuous interpolation).
    const appUp4 = await uploadAndTrace(page, srcFile, { upscaleFactor: 4 });
    const appUp4Diff = await pixelDiffAgainstGroundTruth(page, appUp4.svg, gtDataUrl, GT_SIZE);
    await renderSvgToPng(page, appUp4.svg, path.join(OUT, `${kind}__A2-app-scale2x-4x.png`));
    caseOut.appScale2x4x = { stats: appUp4.stats, diff: appUp4Diff };
    console.log('A2) app baseline (Scale2x 4x, matched resolution):', caseOut.appScale2x4x);

    // (C) Bilinear-then-threshold, factor 2 and 4, turdsize swept 0/2 to
    // check both the production-matched despeckle setting and whether
    // potrace's own despeckle knob changes the fragmentation picture (same
    // sweep #25 ran for its multi-level variant, for direct comparability).
    for (const factor of [2, 4]) {
      const mask = await buildBilinearThresholdMask(page, srcDataUrl, factor);
      for (const turdsize of [0, 2]) {
        const result = await runPotrace(page, mask.dataUrl, { turdsize, ...PRODUCTION_LIKE });
        // Fragmentation measured on the RAW pre-collapse path list, same as
        // #25 — collapsing merges every dark path's `d` into one string, so
        // fragment count/pct must be measured before that merge happens.
        const fragCount = result.paths.filter(p => p.dLength < 100).length;
        const collapsed = await collapsedMergeSvg(page, result.svg, mask.width, mask.height);
        const diff = await pixelDiffAgainstGroundTruth(page, collapsed, gtDataUrl, GT_SIZE);
        const key = `C-bilinear-F${factor}-T${turdsize}`;
        caseOut[key] = {
          otsuThreshold: mask.threshold,
          pathCount: result.paths.length,
          fragCount,
          fragPct: result.paths.length ? +(100 * fragCount / result.paths.length).toFixed(1) : 0,
          rawBytes: result.svg.length,
          collapsedBytes: collapsed.length,
          diff,
          ms: result.ms,
        };
        console.log(`C) bilinear F=${factor} turdsize=${turdsize}:`, caseOut[key]);
        if (turdsize === 0) {
          await renderSvgToPng(page, collapsed, path.join(OUT, `${kind}__C-bilinear-F${factor}.png`));
          fs.writeFileSync(path.join(OUT, `${kind}__C-bilinear-F${factor}.svg`), collapsed);
          fs.writeFileSync(path.join(OUT, `${kind}__C-bilinear-F${factor}-mask.png`),
            Buffer.from(mask.dataUrl.split(',')[1], 'base64'));
        }
      }
    }

    summary[kind] = caseOut;
  }

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  await browser.close();
  console.log('\nDone. Output in', OUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
