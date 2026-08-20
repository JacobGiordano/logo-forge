/*
	potrace-trace.js

	Adapter between this app's tracing pipeline and the vendored
	`esm-potrace-wasm` library (js/potrace-wasm.js, unmodified upstream
	source — see that file's header/package for license and provenance;
	vendored from https://github.com/tomayac/esm-potrace-wasm @ 0.5.1).

	Scope: binary/B&W tracing only (issue #14). Loaded via dynamic import()
	since this project has no build step/bundler and js/potrace-wasm.js is a
	real ES module (not a <script>-global/UMD file like imagetracer.js).

	Responsibilities:
	  - Load + initialize the wasm module once, memoized, with automatic
	    retry-on-next-call if a prior attempt failed (transient load
	    failures shouldn't wedge the app into permanent fallback mode for
	    the rest of the session).
	  - Feature-detect WebAssembly before ever attempting the import.
	  - Run potrace() and normalize its raw output into the same flat,
	    single-fill-per-<path> SVG shape ImageTracer.getsvgstring() already
	    produces, so the existing cleanupSVG()/compactPathData() pipeline in
	    app.js runs completely unmodified over either tracer's output. This
	    is where the two integration gotchas #12 found empirically are
	    handled, once, at the boundary:
	      1. Potrace's `d` coordinates live in a 10x-scaled, Y-flipped
	         space and only render correctly inside the <g transform=
	         "translate(...) scale(0.1,-0.1)"> wrapper it emits — baked
	         into each path's `d` here (bakeD()) rather than carried as a
	         separate transform attribute, so the output is self-contained
	         and numerically in the same space cleanupSVG/compactPathData
	         already expect.
	      2. Potrace puts `fill` on the wrapping <g>, not the <path> —
	         resolved here (resolveEffectiveFill()) by walking up the
	         ancestor chain, so every <path> in the normalized output
	         carries its own explicit `fill`, exactly like imagetracer's
	         output already does. cleanupSVG()'s isLightColor(fill) filter
	         needs no changes as a result.
	  - Approximate path/hole/segment counts for the stats panel (cosmetic
	    only — see collectTraceStats() in app.js — rendering correctness
	    does not depend on this being exact, since cleanupSVG() always
	    merges the full multi-subpath `d` string under fill-rule="evenodd"
	    regardless of tracer).

	Coordinate rounding/compaction: deliberately NOT duplicated here.
	Normalized output is handed to app.js's existing compactPathData()
	unchanged (via cleanupSVG(), unmodified), which already rounds/trims
	precision per the pathSimplify setting — the same step #12/#13 both
	flagged as missing from their spike comparisons. Reusing it directly
	(rather than reimplementing an equivalent) is the literal reading of
	issue #14 point 4 ("equivalent to the app's existing compactPathData()")
	and keeps precision behavior identical between both tracers.
*/

(function () {
  'use strict';

  let potraceModulePromise = null;

  function isSupported() {
    return typeof WebAssembly !== 'undefined';
  }

  // Memoized module load + init. Concurrent callers share the same in-flight
  // promise. On failure, the memo is cleared so the NEXT call retries the
  // import from scratch (handles a transient network hiccup on GitHub Pages
  // without permanently wedging the app into fallback mode for the rest of
  // the session) — per #11 scoping doc's flagged follow-up.
  function loadModule() {
    if (potraceModulePromise) return potraceModulePromise;

    potraceModulePromise = (async () => {
      if (!isSupported()) throw new Error('WebAssembly is not supported in this environment');
      const mod = await import('./potrace-wasm.js');
      await mod.init();
      return mod;
    })();

    potraceModulePromise.catch(() => {
      potraceModulePromise = null;
    });

    return potraceModulePromise;
  }

  // Opportunistic warm-up — call once on first file upload, not on page
  // load, so a cold wasm compile never sits on the critical path of the
  // very first trace. Failures are swallowed here; the real error (if any)
  // surfaces properly the next time trace() is actually called.
  function warm() {
    if (!isSupported()) return;
    loadModule().catch(() => {});
  }

  async function trace(imageData, options) {
    const mod = await loadModule();
    const rawSvg = await mod.potrace(imageData, options);
    return normalize(rawSvg);
  }

  // ── Raw potrace SVG → flat, getsvgstring()-shaped SVG ───────────────────

  function normalize(rawSvgStr) {
    const doc = new DOMParser().parseFromString(rawSvgStr, 'image/svg+xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('potrace-wasm returned unparseable SVG');
    }
    const svgEl = doc.querySelector('svg');
    if (!svgEl) throw new Error('potrace-wasm returned no <svg> root');

    const width = parseFloat(svgEl.getAttribute('width')) || 0;
    const height = parseFloat(svgEl.getAttribute('height')) || 0;
    if (!width || !height) throw new Error('potrace-wasm returned an svg with no usable dimensions');

    let pathCount = 0;
    let holeCount = 0;
    let segmentCount = 0;
    let out = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
      '" viewBox="0 0 ' + width + ' ' + height + '">';

    doc.querySelectorAll('path').forEach(pathEl => {
      const rawD = pathEl.getAttribute('d') || '';
      if (!rawD) return;

      const fill = resolveEffectiveFill(pathEl) || '#000000';
      const { tx, ty, sx, sy } = parseTransform(resolveEffectiveTransform(pathEl));
      const bakedD = bakeD(rawD, tx, ty, sx, sy);

      const shape = analyzeD(rawD);
      pathCount += shape.outerCount;
      holeCount += shape.holeCount;
      segmentCount += shape.segmentCount;

      out += '<path fill="' + fill + '" stroke="none" d="' + bakedD + '" />';
    });

    out += '</svg>';

    return { svgStr: out, pathCount, holeCount, segmentCount };
  }

  // Walks up from a <path> to find the nearest ancestor (including itself)
  // with an explicit `fill` attribute — potrace puts fill on the wrapping
  // <g>, not the <path> (#12 finding).
  function resolveEffectiveFill(el) {
    let n = el;
    while (n) {
      const f = n.getAttribute && n.getAttribute('fill');
      if (f) return f;
      n = n.parentElement;
    }
    return null;
  }

  // Same walk for `transform` — potrace's coordinate-space wrapper lives on
  // the <g>, not the <path> (#12 finding).
  function resolveEffectiveTransform(el) {
    let n = el;
    while (n) {
      const t = n.getAttribute && n.getAttribute('transform');
      if (t) return t;
      n = n.parentElement;
    }
    return null;
  }

  // Parses potrace's known, empirically-verified transform shape:
  // "translate(TX,TY) scale(SX,SY)". Not a general SVG transform-list
  // parser — potrace-wasm has only ever been observed to emit exactly this
  // form (#12, #13 spikes), and a general matrix-composition parser would
  // be unused generality for a vendored dependency whose output shape is
  // fixed. Missing components default to identity.
  function parseTransform(transformStr) {
    let tx = 0, ty = 0, sx = 1, sy = 1;
    if (!transformStr) return { tx, ty, sx, sy };
    const t = transformStr.match(/translate\(\s*(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+)\s*\)/);
    if (t) { tx = parseFloat(t[1]); ty = parseFloat(t[2]); }
    const s = transformStr.match(/scale\(\s*(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+)\s*\)/);
    if (s) { sx = parseFloat(s[1]); sy = parseFloat(s[2]); }
    return { tx, ty, sx, sy };
  }

  // Bakes the ancestor <g>'s transform directly into a path's `d`
  // coordinates instead of carrying it as a separate attribute (issue #14
  // point 3). Uppercase (absolute) commands get the full affine
  // (translate + scale); lowercase (relative) commands are deltas, so only
  // the scale component applies — translation cancels out between two
  // relative points. This is general SVG-semantics-correct (case, not
  // "first M", determines absolute-vs-relative), not just tuned to
  // potrace's specific M-then-all-lowercase output shape.
  function bakeD(d, tx, ty, sx, sy) {
    const segments = d.match(/[MmLlCcZz][^MmLlCcZz]*/g) || [];
    let out = '';
    segments.forEach(seg => {
      const cmd = seg[0];
      if (cmd === 'z' || cmd === 'Z') { out += cmd + ' '; return; }

      const nums = (seg.slice(1).match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
      const isAbsolute = cmd === cmd.toUpperCase();
      const groupSize = cmd.toLowerCase() === 'c' ? 6 : 2;

      const coords = [];
      for (let i = 0; i + 1 < nums.length; i += groupSize) {
        for (let g = 0; g < groupSize && i + g + 1 < nums.length; g += 2) {
          const x = nums[i + g], y = nums[i + g + 1];
          if (isAbsolute) {
            coords.push(round4(tx + sx * x), round4(ty + sy * y));
          } else {
            coords.push(round4(sx * x), round4(sy * y));
          }
        }
      }
      out += cmd + ' ' + coords.join(' ') + ' ';
    });
    return out.trim();
  }

  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  // Approximates outer-contour vs. hole counts from a raw (pre-bake)
  // potrace `d` string, purely for the cosmetic stats panel (see module
  // header — rendering correctness does not depend on this being exact).
  // Classifies each subpath by winding sign via the shoelace formula on
  // its reconstructed vertex sequence (endpoints only, control points
  // ignored — sign-robust for potrace's simple non-self-intersecting
  // contours), then treats the majority sign as "outer" and the minority
  // as "holes". Correct for the common single-depth case; may under-count
  // holes at 3+ levels of nesting (e.g. an island inside a hole gets
  // grouped with the true outers, since it shares their winding sign) —
  // a cosmetic-only limitation, not a rendering one.
  function analyzeD(d) {
    const segments = d.match(/[MmLlCcZz][^MmLlCcZz]*/g) || [];
    const subpaths = [];
    let current = null;
    let segmentCount = 0;
    let cx = 0, cy = 0;

    segments.forEach(seg => {
      const cmd = seg[0];
      const nums = (seg.slice(1).match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);

      if (cmd === 'M' || cmd === 'm') {
        if (current && current.points.length > 2) subpaths.push(current);
        cx = cmd === 'M' ? nums[0] : cx + nums[0];
        cy = cmd === 'M' ? nums[1] : cy + nums[1];
        current = { points: [[cx, cy]] };
      } else if ((cmd === 'l' || cmd === 'L') && current) {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cx = cmd === 'L' ? nums[i] : cx + nums[i];
          cy = cmd === 'L' ? nums[i + 1] : cy + nums[i + 1];
          current.points.push([cx, cy]);
          segmentCount++;
        }
      } else if ((cmd === 'c' || cmd === 'C') && current) {
        for (let i = 0; i + 5 < nums.length; i += 6) {
          cx = cmd === 'C' ? nums[i + 4] : cx + nums[i + 4];
          cy = cmd === 'C' ? nums[i + 5] : cy + nums[i + 5];
          current.points.push([cx, cy]);
          segmentCount++;
        }
      }
      // 'z'/'Z' close the current subpath visually but don't start a new
      // one — the next 'm'/'M' (or end of string) is what flushes `current`.
    });
    if (current && current.points.length > 2) subpaths.push(current);

    let outerCount = 0, holeCount = 0;
    if (subpaths.length) {
      subpaths.forEach(sp => { sp.signedArea = shoelace(sp.points); });
      const positive = subpaths.filter(sp => sp.signedArea > 0).length;
      const majoritySign = positive >= subpaths.length - positive ? 1 : -1;
      subpaths.forEach(sp => {
        const sign = sp.signedArea > 0 ? 1 : -1;
        if (sign === majoritySign) outerCount++; else holeCount++;
      });
    }

    return { outerCount, holeCount, segmentCount };
  }

  function shoelace(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
  }

  window.PotraceTrace = { isSupported, warm, trace };
})();
