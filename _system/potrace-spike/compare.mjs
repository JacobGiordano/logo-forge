// Throwaway spike harness for issue #12 — compares the app's current
// imagetracer.js pipeline against esm-potrace-wasm on real/synthetic test
// logos. NOT part of the shipped app. Drives the real app in a real browser
// via Playwright so we exercise the actual preprocessImageData/buildTraceOptions/
// cleanupSVG code paths rather than re-implementing them.
//
// Usage: node _system/potrace-spike/compare.mjs
// Requires: `npx serve . -l 4321` already running (or this script will fail
// fast with a clear error).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const BASE_URL = 'http://localhost:4321';

// ── Synthetic test image generators (drawn in-page via canvas) ─────────────
const GENERATORS = {
  // A ring/donut — the single clearest test of hole/winding correctness:
  // one filled path with one true topological hole.
  ring: `
    const c = document.createElement('canvas');
    c.width = 220; c.height = 220;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,220,220);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(110,110,90,0,Math.PI*2);
    ctx.arc(110,110,40,0,Math.PI*2,true);
    ctx.fill('evenodd');
    return c.toDataURL('image/png');
  `,
  // A smooth rounded blob with a concave notch — tests curve-fitting
  // smoothness and corner handling, no holes.
  blob: `
    const c = document.createElement('canvas');
    c.width = 220; c.height = 220;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,220,220);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    const cx=110, cy=110, rBase=80;
    for (let i=0;i<=64;i++){
      const t = (i/64)*Math.PI*2;
      const wobble = 1 + 0.18*Math.sin(t*5) - (t>2.6&&t<3.2 ? 0.5 : 0);
      const r = rBase*wobble;
      const x = cx + r*Math.cos(t), y = cy + r*Math.sin(t);
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.fill();
    return c.toDataURL('image/png');
  `,
  // Multi-tone concentric bands — for Track B color-aware comparison.
  // Five distinct flat colors, no anti-aliasing gradient, to keep
  // posterization/quantization behavior comparable across both tracers.
  bands: `
    const c = document.createElement('canvas');
    c.width = 220; c.height = 220;
    const ctx = c.getContext('2d');
    const colors = ['#ffffff','#f2c14e','#f78154','#b4436c','#4d5061','#1b1b1e'];
    ctx.fillStyle = colors[0]; ctx.fillRect(0,0,220,220);
    for (let i=1;i<colors.length;i++){
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      ctx.arc(110,110,95 - (i-1)*17,0,Math.PI*2);
      ctx.fill();
    }
    return c.toDataURL('image/png');
  `,
};

async function generateSynthetic(page, kind) {
  const body = GENERATORS[kind];
  const dataUrl = await page.evaluate(new Function(body));
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  const p = path.join(OUT, `synthetic-${kind}.png`);
  fs.writeFileSync(p, buf);
  return p;
}

async function uploadAndTrace(page, filePath, settingsOverride = {}) {
  await page.locator('#file-input').setInputFiles(filePath);
  await page.locator('#trace-btn').waitFor({ state: 'visible' });
  await page.locator('#trace-btn').isEnabled({ timeout: 5000 });

  for (const [id, val] of Object.entries(settingsOverride)) {
    const el = page.locator('#' + id);
    await el.fill(String(val));
  }

  const t0 = Date.now();
  await page.locator('#trace-btn').click();
  await page.locator('#status').filter({ hasText: 'Done' }).waitFor({ timeout: 20000 });
  const t1 = Date.now();

  // NOTE: app.js declares currentSVG/currentMaskPreview/currentTraceStats
  // with top-level `let` in a classic (non-module) script, so they are
  // script-scope bindings, NOT window.* properties — unlike `var`/function
  // declarations. They are not readable from outside the page's script
  // realm via window.*. Pull the same data back out of the rendered DOM
  // instead (renderSVGTab() writes it there right after a trace).
  const result = await page.evaluate(() => {
    const svg = document.querySelector('.prev-card-body.on-light')?.innerHTML || null;
    const maskImg = document.querySelector('.mask-preview img');
    const metaText = document.getElementById('svg-meta')?.innerText || '';
    const num = re => {
      const m = metaText.match(re);
      return m ? Number(m[1]) : null;
    };
    return {
      svg,
      maskPreview: maskImg ? maskImg.src : null,
      maskWidth: maskImg ? maskImg.naturalWidth : null,
      maskHeight: maskImg ? maskImg.naturalHeight : null,
      stats: {
        pathCount: num(/Paths:\s*(\d+)/),
        holeCount: num(/Holes:\s*(\d+)/),
        byteSizeKB: num(/Size:\s*([\d.]+)\s*KB/),
      },
    };
  });
  return { ...result, appTraceMs: t1 - t0 };
}

async function loadPotrace(page) {
  await page.evaluate(async () => {
    if (window.__potraceMod) return;
    const mod = await import('/_system/potrace-spike/vendor/potrace-wasm.js');
    await mod.init();
    window.__potraceMod = mod;
  });
}

// Runs potrace-wasm on a given data-URL image source, returns raw svg string,
// per-path fill-rule info, and timing. options are passed straight through.
async function runPotrace(page, dataUrl, options) {
  return page.evaluate(
    async ({ dataUrl, options }) => {
      const img = new Image();
      const loaded = new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
      });
      img.src = dataUrl;
      await loaded;
      const t0 = performance.now();
      const svg = await window.__potraceMod.potrace(img, options);
      const t1 = performance.now();

      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      // FINDING: potrace's SVG output puts `fill` on the wrapping <g> per
      // color layer, not on each <path> — unlike imagetracer's per-path
      // fill. Resolve the effective (inherited) fill by walking up.
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
        fillRuleOwn: p.getAttribute('fill-rule'),
        fillRuleEffective: (() => {
          let n = p;
          while (n) {
            const fr = n.getAttribute && n.getAttribute('fill-rule');
            if (fr) return fr;
            n = n.parentElement;
          }
          return '(unspecified => SVG default nonzero)';
        })(),
        dLength: (p.getAttribute('d') || '').length,
      }));
      return { svg, paths, ms: t1 - t0 };
    },
    { dataUrl, options }
  );
}

// Builds the "naive cleanupSVG-style" evenodd merge from potrace's own path
// d-strings, to directly test the winding/fill-rule risk #11 flagged: does
// concatenating potrace's subpaths into one evenodd path (exactly what
// cleanupSVG does to imagetracer output) still render holes correctly?
function naiveEvenoddMerge(svgStr, isLight) {
  const doc = new DOMParser === 'undefined' ? null : null; // placeholder, real parse happens in-page
  return svgStr; // unused on Node side; see inPageNaiveMerge below
}

async function inPageNaiveMerge(page, svgStr, width, height) {
  return page.evaluate(
    ({ svgStr, width, height }) => {
      function isLightColor(c) {
        if (!c) return true;
        if (c === 'none') return true;
        const m = c.match(/^#([0-9a-f]{6})$/i);
        if (!m) return false;
        const r = parseInt(m[1].slice(0, 2), 16);
        const g = parseInt(m[1].slice(2, 4), 16);
        const b = parseInt(m[1].slice(4, 6), 16);
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        return lum > 200;
      }
      const doc = new DOMParser().parseFromString(svgStr, 'image/svg+xml');
      function effectiveFill(el) {
        let n = el;
        while (n) {
          const f = n.getAttribute && n.getAttribute('fill');
          if (f) return f;
          n = n.parentElement;
        }
        return null;
      }
      // FINDING #2: potrace emits path coordinates in its own internal
      // space (10x scale, Y-flipped) and relies on the wrapping <g
      // transform="translate(...) scale(0.1,-0.1)"> to map into normal
      // viewBox units. cleanupSVG's real merge only concatenates raw `d`
      // strings with no transform carried along — naively doing that to
      // potrace's `d` (as a first pass here did) puts every point 10x too
      // large and Y-inverted, off-canvas. Carry the ancestor <g>'s
      // transform onto the merged <path> so this test isolates the
      // winding/fill-rule question from this separate, real integration
      // detail (a genuine implementation would need to either keep this
      // transform or bake it into the `d` coordinates before merging).
      function effectiveTransform(el) {
        let n = el;
        while (n) {
          const t = n.getAttribute && n.getAttribute('transform');
          if (t) return t;
          n = n.parentElement;
        }
        return null;
      }
      const darkPathData = [];
      let transform = null;
      doc.querySelectorAll('path').forEach(p => {
        // potrace puts fill on the ancestor <g>, not the <path> — same fix
        // as runPotrace's effectiveFill, applied here so this mirrors what
        // cleanupSVG's real isLightColor(fill) filter would see if it were
        // pointed at potrace output instead of imagetracer output.
        const fill = (effectiveFill(p) || '').toLowerCase().replace(/\s/g, '');
        if (!isLightColor(fill)) {
          const d = p.getAttribute('d') || '';
          if (d) {
            darkPathData.push(d);
            if (!transform) transform = effectiveTransform(p);
          }
        }
      });
      const transformAttr = transform ? ` transform="${transform}"` : '';
      const merged = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><path fill="#000000" fill-rule="evenodd" stroke="none"${transformAttr} d="${darkPathData.join(' ')}"/></svg>`;
      return merged;
    },
    { svgStr, width, height }
  );
}

// Renders an SVG string to a PNG file by drawing it into an <img> on the page
// and screenshotting the element — avoids needing any image-conversion lib.
async function renderSvgToPng(page, svgStr, outPath, size = 300) {
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
  await page.waitForTimeout(50); // let the data-URL SVG actually paint
  await img.screenshot({ path: outPath });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const log = [];
  const record = (...args) => {
    console.log(...args);
    log.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  await page.goto(BASE_URL);
  await loadPotrace(page);
  record('potrace-wasm module loaded and initialized OK');

  const cases = [
    { name: 'checkerboard-fixture', file: path.resolve(__dirname, '../../tests/fixtures/test-logo.png') },
    { name: 'ring', file: await generateSynthetic(page, 'ring') },
    { name: 'blob', file: await generateSynthetic(page, 'blob') },
  ];

  const summary = {};

  for (const c of cases) {
    record('\n=== Case:', c.name, '===');
    const app = await uploadAndTrace(page, c.file);
    record('App pipeline:', {
      appTraceMs: app.appTraceMs,
      stats: app.stats,
      svgBytes: app.svg.length,
    });

    // Track A: feed potrace-wasm the SAME binary mask the app's own tracer
    // consumed (window.currentMaskPreview) for a true apples-to-apples
    // curve-fitting comparison, isolated from any threshold/quantization
    // differences.
    const potraceBinary = await runPotrace(page, app.maskPreview, {
      turdsize: 0, // despeckle already applied upstream by preprocessImageData
      turnpolicy: 4,
      alphamax: 1,
      opticurve: 1,
      opttolerance: 0.2,
      pathonly: false,
      extractcolors: true,
      posterizelevel: 2,
      posterizationalgorithm: 0,
    });
    record('Potrace (binary, on app mask):', {
      ms: potraceBinary.ms,
      svgBytes: potraceBinary.svg.length,
      paths: potraceBinary.paths,
    });

    const naiveMerge = await inPageNaiveMerge(
      page,
      potraceBinary.svg,
      app.maskWidth,
      app.maskHeight
    );

    // Render all three variants for visual diffing.
    await renderSvgToPng(page, app.svg, path.join(OUT, `${c.name}__A-app.png`));
    await renderSvgToPng(page, potraceBinary.svg, path.join(OUT, `${c.name}__B-potrace-native.png`));
    await renderSvgToPng(page, naiveMerge, path.join(OUT, `${c.name}__C-potrace-naive-evenodd.png`));

    fs.writeFileSync(path.join(OUT, `${c.name}__app.svg`), app.svg);
    fs.writeFileSync(path.join(OUT, `${c.name}__potrace-native.svg`), potraceBinary.svg);
    fs.writeFileSync(path.join(OUT, `${c.name}__potrace-naive-evenodd.svg`), naiveMerge);

    summary[c.name] = {
      app: { ms: app.appTraceMs, bytes: app.svg.length, stats: app.stats },
      potraceBinary: { ms: potraceBinary.ms, bytes: potraceBinary.svg.length, paths: potraceBinary.paths },
    };
  }

  // ── Track B: color-aware comparison on a multi-tone synthetic logo ───────
  record('\n=== Track B: color-aware (bands) ===');
  const bandsFile = await generateSynthetic(page, 'bands');
  const bandsDataUrl = 'data:image/png;base64,' + fs.readFileSync(bandsFile).toString('base64');

  // App's current forced-binary output on the multi-tone source, for reference.
  const appBands = await uploadAndTrace(page, bandsFile);
  record('App pipeline (forced binary) on multi-tone source:', {
    stats: appBands.stats,
    svgBytes: appBands.svg.length,
  });
  await renderSvgToPng(page, appBands.svg, path.join(OUT, 'bands__A-app-binary.png'));
  fs.writeFileSync(path.join(OUT, 'bands__app-binary.svg'), appBands.svg);

  // Potrace's native color mode: extractcolors:true, feeding the ORIGINAL
  // (non-binarized) image directly, at a couple of posterizelevels.
  for (const posterizelevel of [3, 6]) {
    const potraceColor = await runPotrace(page, bandsDataUrl, {
      turdsize: 2,
      turnpolicy: 4,
      alphamax: 1,
      opticurve: 1,
      opttolerance: 0.2,
      pathonly: false,
      extractcolors: true,
      posterizelevel,
      posterizationalgorithm: 1,
    });
    record(`Potrace (color, posterizelevel=${posterizelevel}):`, {
      ms: potraceColor.ms,
      svgBytes: potraceColor.svg.length,
      pathCount: potraceColor.paths.length,
      paths: potraceColor.paths,
    });
    await renderSvgToPng(
      page,
      potraceColor.svg,
      path.join(OUT, `bands__B-potrace-color-p${posterizelevel}.png`)
    );
    fs.writeFileSync(path.join(OUT, `bands__potrace-color-p${posterizelevel}.svg`), potraceColor.svg);
    summary['bands-color-p' + posterizelevel] = {
      ms: potraceColor.ms,
      bytes: potraceColor.svg.length,
      pathCount: potraceColor.paths.length,
    };
  }

  // Also render the original source image itself for reference in the diff.
  fs.copyFileSync(bandsFile, path.join(OUT, 'bands__0-source.png'));

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n'));

  await browser.close();
  record('\nDone. Output in', OUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
