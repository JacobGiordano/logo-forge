// Extension of compare.mjs for issue #13 — tests potrace-wasm's actual
// tuning knobs (alphamax/opttolerance) against real, harder content, not
// synthetic shapes at default-vs-default (which is all #12 tested).
//
// Same harness pattern as compare.mjs: drives the real running app via
// Playwright (upload -> Trace -> read DOM), so every "app" number below is
// the app's actual preprocessImageData/buildTraceOptions/cleanupSVG output,
// not a reimplementation. Reuses the same vendored potrace-wasm module and
// the same naive-evenodd-merge + coordinate-transform-carrying logic
// compare.mjs already worked out (see its FINDING comments) rather than
// re-deriving it.
//
// Usage: node _system/potrace-spike/compare-curve-quality.mjs
// Requires: `npx serve . -l 4321` already running.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out-13');
fs.mkdirSync(OUT, { recursive: true });

const BASE_URL = 'http://localhost:4321';

// Crops taken from the user-provided 512-icon reference sheet
// (_screenshots/..., gitignored, local-only test input — same treatment as
// #12's out/ directory: regenerable, not committed).
const CROPS_DIR = path.join(
  '/tmp/claude-1000/-workspace/2d99087e-4994-4631-99fe-930ab1091562/scratchpad/crops'
);
const CASES = [
  {
    name: 'sharp-corners',
    file: path.join(CROPS_DIR, 'candidate-arrows.png'),
    note: 'UP/DOWN/LEFT/RIGHT + 4 diagonal arrows — pure right-angle/acute-angle geometry, no curves at all. Best case for testing corner sharpness.',
  },
  {
    name: 'fine-detail',
    file: path.join(CROPS_DIR, 'candidate-fine-detail.png'),
    note: 'BRUTE(fist) BURN(flame) CACHE(stack) CAPTURE(crosshair) CLOAK(hooded figure) CLOSE(x-circle) COMMAND(crown) COMMIT(arrow-box) — dense small glyphs + text labels, mix of curves and sharp points.',
  },
  {
    name: 'nested-holes',
    file: path.join(CROPS_DIR, 'candidate-tag-throttle.png'),
    note: 'TAG TARGET TERMINUS THROTTLE / TRACE TRACK TRIGGER TUNNEL — TARGET and TRACK are bullseye icons: filled ring -> hole -> filled center dot, real 3-level nesting (fill/hole/island), not just a single hole. TRIGGER is a fingerprint (dense concentric curves).',
  },
];

// Three tuning points, not just potrace's library default. alphamax controls
// corner-detection aggressiveness (0 = keep everything sharp, ~1.34 = smooth
// everything into curves, library default 1). opttolerance controls
// curve-fit tightness (lower = tighter/more nodes, higher = looser/fewer
// nodes, library default 0.2).
const POTRACE_PRESETS = {
  default: { alphamax: 1, opttolerance: 0.2 },
  tight: { alphamax: 0.2, opttolerance: 0.05 }, // high-fidelity: preserve corners, tight curve fit
  smooth: { alphamax: 1.3, opttolerance: 0.8 }, // loose: round everything, fewer nodes
};

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
  await page.locator('#status').filter({ hasText: 'Done' }).waitFor({ timeout: 30000 });
  const t1 = Date.now();

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

// Same transform-carrying + inherited-fill evenodd merge #12 verified.
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

async function renderSvgToPng(page, svgStr, outPath, width, height, scale = 4) {
  await page.evaluate(
    ({ svgStr, width, height, scale }) => {
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
      img.style.width = width * scale + 'px';
      img.style.height = height * scale + 'px';
      img.style.imageRendering = 'pixelated';
      img.style.display = 'block';
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
      holder.appendChild(img);
    },
    { svgStr, width, height, scale }
  );
  const img = page.locator('#__spike_render_img');
  await img.waitFor({ state: 'visible' });
  await page.waitForTimeout(80);
  await img.screenshot({ path: outPath });
}

function countHolesRough(svgStr) {
  // Rough proxy: count subpaths (M commands) per path minus 1, summed.
  const matches = svgStr.match(/M/g);
  return matches ? matches.length : 0;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const log = [];
  const record = (...args) => {
    console.log(...args);
    log.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  await page.goto(BASE_URL);
  await loadPotrace(page);
  record('potrace-wasm module loaded and initialized OK');

  const summary = {};

  for (const c of CASES) {
    record('\n=== Case:', c.name, '===');
    record('  ', c.note);
    if (!fs.existsSync(c.file)) {
      record('  SKIP — file not found:', c.file);
      continue;
    }

    const app = await uploadAndTrace(page, c.file);
    record('App pipeline (imagetracer, default settings):', {
      appTraceMs: app.appTraceMs,
      stats: app.stats,
      svgBytes: app.svg ? app.svg.length : null,
      maskDims: `${app.maskWidth}x${app.maskHeight}`,
    });
    if (app.svg) {
      fs.writeFileSync(path.join(OUT, `${c.name}__app.svg`), app.svg);
      await renderSvgToPng(
        page,
        app.svg,
        path.join(OUT, `${c.name}__app.png`),
        app.maskWidth,
        app.maskHeight
      );
    }

    summary[c.name] = { app: { ms: app.appTraceMs, bytes: app.svg?.length, stats: app.stats } };

    for (const [presetName, opts] of Object.entries(POTRACE_PRESETS)) {
      const potraceResult = await runPotrace(page, app.maskPreview, {
        turdsize: 0, // despeckle already applied upstream by preprocessImageData, same as #12
        turnpolicy: 4,
        opticurve: 1,
        pathonly: false,
        extractcolors: true,
        posterizelevel: 2,
        posterizationalgorithm: 0,
        ...opts,
      });
      const merged = await inPageNaiveMerge(
        page,
        potraceResult.svg,
        app.maskWidth,
        app.maskHeight
      );
      const holesRough = countHolesRough(merged);

      record(`Potrace [${presetName}] alphamax=${opts.alphamax} opttolerance=${opts.opttolerance}:`, {
        ms: potraceResult.ms,
        rawSvgBytes: potraceResult.svg.length,
        mergedBytes: merged.length,
        pathElements: potraceResult.paths.length,
        subpathsInMerge: holesRough,
      });

      fs.writeFileSync(path.join(OUT, `${c.name}__potrace-${presetName}-raw.svg`), potraceResult.svg);
      fs.writeFileSync(path.join(OUT, `${c.name}__potrace-${presetName}-merged.svg`), merged);
      await renderSvgToPng(
        page,
        merged,
        path.join(OUT, `${c.name}__potrace-${presetName}.png`),
        app.maskWidth,
        app.maskHeight
      );

      summary[c.name][`potrace-${presetName}`] = {
        ms: potraceResult.ms,
        mergedBytes: merged.length,
        pathElements: potraceResult.paths.length,
        subpathsInMerge: holesRough,
      };
    }
  }

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n'));

  await browser.close();
  record('\nDone. Output in', OUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
