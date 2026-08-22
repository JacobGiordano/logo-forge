// Throwaway spike harness for issue #25 — investigates whether tracing
// against a multi-level/antialiased luminance representation, instead of
// the app's current hard 2-color Otsu binarize (js/app.js buildMask), closes
// any of the quality gap against Adobe Illustrator's Image Trace. Extends
// #12's compare.mjs and #13's compare-curve-quality.mjs patterns (same
// upload-and-read-DOM harness against the REAL running app for the "before"
// baseline; direct potrace-wasm calls, bypassing the UI, for the "after"
// experiments the UI has no toggle for).
//
// Usage: node _system/potrace-spike/compare-antialiased-edges.mjs
// Requires: `npx serve . -l 4321` already running.
// Outputs land in _system/potrace-spike/out-25/ (gitignored-by-convention,
// regenerate on demand, not committed).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out-25');
fs.mkdirSync(OUT, { recursive: true });
const BASE_URL = 'http://localhost:4321';

// ── Synthetic test shapes ───────────────────────────────────────────────
// Each generator draws the SAME vector shape at an arbitrary canvas size —
// called once at working resolution (240x240, what gets "uploaded") and
// once at 4x (960x960) as a native-antialiased ground-truth reference,
// never produced by upscaling a bitmap. Canvas fill/arc calls antialias by
// default (no manual AA needed) — that native edge gradient is exactly the
// sub-pixel information the app's Otsu binarize destroys at upload time.
const SHAPES = {
  // Geometric/flat-color case: sharp points and straight concave notches,
  // zero curves. Best case for corner-sharpness comparison (mirrors #13's
  // sharp-corners case).
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
  // Detailed/curved case: smooth organic silhouette with a thin curved
  // stroke-like appendage, to stress fine antialiased curve detail
  // (mirrors #13's fine-detail intent, single shape instead of an icon
  // sheet since this spike isn't reusing #13's local-only screenshot input).
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
    // thin curved handle (stress fine antialiased stroke edges)
    ctx.lineWidth = ${s}*0.045;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + r*0.75, cy + r*0.75);
    ctx.quadraticCurveTo(${s}*0.75, ${s}*0.75, ${s}*0.88, ${s}*0.9);
    ctx.stroke();
    return c.toDataURL('image/png');
  `,
  // Topology case: filled ring -> hole -> filled center dot (3-level
  // nesting), with curved (circular) boundaries throughout, to check
  // whether multi-level tracing preserves hole topology as cleanly as
  // #13 found the binary path does.
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

// ── Drive the real app (baseline) ───────────────────────────────────────
async function uploadAndTrace(page, filePath) {
  await page.locator('#file-input').setInputFiles(filePath);
  await page.locator('#trace-btn').waitFor({ state: 'visible' });
  await page.locator('#trace-btn').isEnabled({ timeout: 5000 });
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

// ── Direct potrace-wasm calls (bypass UI — no toggle exists for these) ──
async function loadPotrace(page) {
  await page.evaluate(async () => {
    if (window.__potraceMod) return;
    const mod = await import('/js/potrace-wasm.js');
    await mod.init();
    window.__potraceMod = mod;
  });
}

// Builds a multi-level (posterized-but-not-binary) grayscale ImageData from
// a source data URL, replicating the app's own luminance math (0.299/0.587/
// 0.114, alpha-composited onto white — see preprocessImageData in js/app.js)
// but quantizing into `levels` evenly spaced luminance bands instead of a
// single Otsu threshold. `levels=2` reproduces the app's current hard
// binarize exactly (as a sanity control); `levels>2` is the issue's literal
// ask #1. Runs in-page so it can use the DOM Image/canvas APIs.
async function buildPosterizedImageData(page, dataUrl, levels) {
  return page.evaluate(
    async ({ dataUrl, levels }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const src = ctx.getImageData(0, 0, c.width, c.height);
      const out = new Uint8ClampedArray(src.data.length);
      for (let i = 0; i < src.data.length; i += 4) {
        const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2], a = src.data[i + 3] / 255;
        const lum = (r * 0.299 + g * 0.587 + b * 0.114) * a + 255 * (1 - a);
        const band = Math.min(levels - 1, Math.floor((lum / 256) * levels));
        const gray = Math.round((band / (levels - 1)) * 255);
        out[i] = gray; out[i + 1] = gray; out[i + 2] = gray; out[i + 3] = 255;
      }
      // Serialize as a data URL (structured clone of raw ImageData across
      // the evaluate boundary is unreliable for large typed arrays in some
      // Playwright versions) — reconstructed on the other side via putImageData.
      const outCanvas = document.createElement('canvas');
      outCanvas.width = c.width; outCanvas.height = c.height;
      outCanvas.getContext('2d').putImageData(new ImageData(out, c.width, c.height), 0, 0);
      return { dataUrl: outCanvas.toDataURL('image/png'), width: c.width, height: c.height };
    },
    { dataUrl, levels }
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

function fillLuma(fill) {
  if (!fill) return 255;
  const m = fill.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return 255;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return r * 0.299 + g * 0.587 + b * 0.114;
}

// Collapses a multi-level potrace result down to the single flat dark
// silhouette a real export would need (evenodd-merge every path whose
// resolved fill luma < 128), mirroring app.js's cleanupSVG. This is the
// fair, apples-to-apples comparison for "would this actually improve the
// SVG this app ships," as opposed to the raw multi-band output (which is a
// fundamentally different multi-tone artifact, not a flat logo silhouette).
function collapseDarkPaths(potraceResult, width, height) {
  const darkD = potraceResult.paths.filter(p => fillLuma(p.fill) < 128);
  return darkD;
}

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

const TIGHT = { alphamax: 0.35, opttolerance: 0.05 }; // #13/#16-validated tuned preset, held constant
                                                       // across all variants so this spike isolates the
                                                       // posterization-level axis, not curve-fit tuning
                                                       // (already covered by #13).
const WORK_SIZE = 240;
const GT_SIZE = 960; // 4x working resolution, native-AA ground truth

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

    // (A) Baseline: the app's real current production pipeline (hard Otsu
    // binarize, potrace-wasm default engine per #14, posterizelevel:2).
    const app = await uploadAndTrace(page, srcFile);
    const appDiff = await pixelDiffAgainstGroundTruth(page, app.svg, gtDataUrl, GT_SIZE);
    await renderSvgToPng(page, app.svg, path.join(OUT, `${kind}__A-app-baseline.png`));
    caseOut.appBaseline = { stats: app.stats, diff: appDiff, engine: app.stats.engine };
    console.log('A) app baseline:', caseOut.appBaseline);

    // (B) Ask #1: multi-level posterize BEFORE tracing (levels=4,8), fed
    // through potrace's own extractcolors/posterizelevel machinery, tuned
    // alphamax/opttolerance held constant at TIGHT. turdsize swept to test
    // whether Track B's (#12) speckle-fragmentation finding — which was on
    // full-color photographic input — reproduces on a flat-color logo shape
    // where AA noise is confined to a thin edge ring, not spread across the
    // whole image.
    for (const levels of [4, 8]) {
      for (const turdsize of [0, 2]) {
        const posterized = await buildPosterizedImageData(page, srcDataUrl, levels);
        const result = await runPotrace(page, posterized.dataUrl, {
          turdsize, turnpolicy: 4, opticurve: 1, pathonly: false,
          extractcolors: true, posterizelevel: levels, posterizationalgorithm: 0,
          ...TIGHT,
        });
        const fragCount = result.paths.filter(p => p.dLength < 100).length;
        const collapsed = await collapsedMergeSvg(page, result.svg, posterized.width, posterized.height);
        const rawDiff = await pixelDiffAgainstGroundTruth(page, result.svg, gtDataUrl, GT_SIZE);
        const collapsedDiff = await pixelDiffAgainstGroundTruth(page, collapsed, gtDataUrl, GT_SIZE);
        const key = `B-multilevel-L${levels}-T${turdsize}`;
        caseOut[key] = {
          pathCount: result.paths.length,
          fragCount,
          fragPct: +(100 * fragCount / result.paths.length).toFixed(1),
          rawBytes: result.svg.length,
          collapsedBytes: collapsed.length,
          rawDiff, collapsedDiff, ms: result.ms,
        };
        console.log(`B) multilevel L=${levels} turdsize=${turdsize}:`, caseOut[key]);
        if (levels === 4 && turdsize === 0) {
          await renderSvgToPng(page, result.svg, path.join(OUT, `${kind}__B-multilevel-raw.png`));
          await renderSvgToPng(page, collapsed, path.join(OUT, `${kind}__B-multilevel-collapsed.png`));
          fs.writeFileSync(path.join(OUT, `${kind}__B-multilevel-raw.svg`), result.svg);
          fs.writeFileSync(path.join(OUT, `${kind}__B-multilevel-collapsed.svg`), collapsed);
        }
      }
    }

    // (C) Ask #2: feed the RAW (non-quantized) antialiased source directly
    // to potrace, letting its OWN internal posterization/extractcolors
    // machinery pick bands, at a couple of posterizelevel settings — tests
    // whether potrace-wasm can accept grayscale/AA input directly rather
    // than a pre-quantized multi-level mask built by this app's own code.
    for (const levels of [4, 8]) {
      const result = await runPotrace(page, srcDataUrl, {
        turdsize: 2, turnpolicy: 4, opticurve: 1, pathonly: false,
        extractcolors: true, posterizelevel: levels, posterizationalgorithm: 1,
        ...TIGHT,
      });
      const fragCount = result.paths.filter(p => p.dLength < 100).length;
      const collapsed = await collapsedMergeSvg(page, result.svg, WORK_SIZE, WORK_SIZE);
      const rawDiff = await pixelDiffAgainstGroundTruth(page, result.svg, gtDataUrl, GT_SIZE);
      const collapsedDiff = await pixelDiffAgainstGroundTruth(page, collapsed, gtDataUrl, GT_SIZE);
      const key = `C-rawAA-potraceOwnPosterize-L${levels}`;
      caseOut[key] = {
        pathCount: result.paths.length,
        fragCount,
        fragPct: +(100 * fragCount / result.paths.length).toFixed(1),
        rawBytes: result.svg.length,
        collapsedBytes: collapsed.length,
        rawDiff, collapsedDiff, ms: result.ms,
      };
      console.log(`C) raw-AA potrace-own-posterize L=${levels}:`, caseOut[key]);
      if (levels === 8) {
        await renderSvgToPng(page, result.svg, path.join(OUT, `${kind}__C-rawAA-raw.png`));
        fs.writeFileSync(path.join(OUT, `${kind}__C-rawAA-raw.svg`), result.svg);
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
