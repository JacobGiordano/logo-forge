import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Coverage for issue #36 -- #34 wired bilinear-presupersample into
// production (pre-threshold bilinear supersampling, hard-capped at 2x,
// replacing the Scale2x-family upscale's 2x tier) with zero Playwright
// coverage of its own. Four gaps, each its own describe block below:
//   1. The bilinear-2x path actually running end-to-end (not just "some
//      upscale happened") for an image below BILINEAR_NATIVE_SAFE_LIMIT.
//   2. The native-fallback path at/above BILINEAR_NATIVE_SAFE_LIMIT (3500,
//      js/app.js) -- no Worker constructed, and a correct native trace, not
//      just "didn't crash."
//   3. A regression guard that the pre-#34 3x/4x upscale-factor options
//      stay gone from the UI.
//   4. Worker failure handling (construction failure and hang/timeout) --
//      confirms the app degrades to a visible, working fallback rather than
//      hanging or erroring out silently.
//
// How "what actually ran" is observed without touching js/app.js: the SVG
// tab's #svg-meta panel (js/app.js renderSVGTab) renders a "Supersample:"
// meta-chip with the exact maskWidth/maskHeight and mode ('bilinear' vs
// 'Scale2x (native fallback)') whenever stats.upscaleFactor > 1, and is
// absent entirely when it's 1 (native, no upscale). Separately, the
// exported SVG itself (rendered live into .prev-card-body.on-light) carries
// a viewBox in mask-pixel units alongside width/height attributes pinned to
// the native source size (js/app.js cleanupSVG) -- so viewBox vs
// width/height is a second, independent confirmation of what resolution was
// actually traced, straight from the public export artifact.

const SMALL_FIXTURE = path.resolve(__dirname, 'fixtures/select-sheet.png'); // 512x512
// Exactly at BILINEAR_NATIVE_SAFE_LIMIT (3500, js/app.js) -- generated for
// this issue since no existing fixture is anywhere near this size (the
// largest, select-sheet.png/-aa.png, is 512x512). Pure-Node PNG encoder
// (RGBA8/deflate, no filtering) -- same "no canvas/native image lib in this
// repo's node_modules" constraint noted in tests/selection.spec.ts's
// fixture comment; see git history for the generation script if it needs
// regenerating. Content: a centered, sharp-edged black square (40% side
// length) on white, same flat-fill style as the other fixtures -- gives an
// unambiguous non-zero coverage ratio and compresses to ~65KB despite the
// 3500x3500 canvas.
const AT_GATE_FIXTURE = path.resolve(__dirname, 'fixtures/large-native-3500.png');
// Same generation, one pixel narrower/shorter -- the other side of the
// boundary. Exists specifically to pin the gate's `>=` (not `>`) operator:
// 3499 must still attempt bilinear-2x (Worker constructed, mask doubles),
// only 3500 must skip it entirely. A test suite that only ever checked "big
// enough" and "way past the gate" would miss an off-by-one flip of that
// comparison; this is exactly the class of bug HANDOFF.md's "unified the
// gate" fix (#34 follow-up 2) was about, so both edges are covered.
const BELOW_GATE_FIXTURE = path.resolve(__dirname, 'fixtures/large-below-gate-3499.png');

const BILINEAR_NATIVE_SAFE_LIMIT = 3500; // js/app.js -- see comment above

async function waitForFileReady(page: Page) {
  await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
}

async function traceAndExpectStatus(page: Page, text: string, cls: string, timeout = 20000) {
  await page.locator('#trace-btn').click();
  await expect(page.locator('#status')).toHaveText(text, { timeout });
  await expect(page.locator('#status')).toHaveClass(cls);
}

// Draws a small interior box, then drags BOTH resize handles out past their
// respective canvas edges (overshooting well beyond the canvas on purpose),
// so the confirmed selection ends up spanning the ENTIRE source image at its
// true native size -- not the auto-trimmed subject bbox (auto-trim is
// turned off first).
//
// Two-step approach, not a single corner-to-corner drag, because a drag's
// mousedown must land ON #select-canvas to fire onSelectDragStart at all --
// starting it exactly at/beyond the canvas's own edge risks hitting
// .select-canvas-wrap's border-radius-clipped corner instead (the exact trap
// tests/selection.spec.ts's auto-trim test comments call out, which is what
// silently no-op'd every drag the first time this helper was written: the
// confirm button never enabled because dragMode never got set). The initial
// box (dragOnCanvas-style, well inside the canvas, same geometry
// selection.spec.ts already proves is a safe hit-testing zone) sidesteps
// that. From there, each handle drag is grabbed at the box's own rendered
// corner (mirroring selection.spec.ts's passing "resizing via a corner
// handle" test) and moved via document-level mousemove listeners, which
// need no further hit-testing -- eventToCanvasPoint's clamp to
// [0, canvas.width]/[0, canvas.height] (js/app.js clientPointToCanvasPoint)
// does the rest, landing each corner on an EXACT canvas-display edge
// regardless of how far the overshoot goes. That exactness is what lets the
// two large fixtures below pin an EXACT native pixel size (3499 vs 3500)
// rather than an approximate one.
async function uploadFullCanvasSelection(page: Page, fixture: string) {
  await page.goto('http://localhost:4321');
  await page.locator('#file-input').setInputFiles(fixture);
  await expect(page.locator('#select-wrap')).toBeVisible({ timeout: 5000 });

  await page.locator('#select-autotrim-btn').click();
  await expect(page.locator('#select-autotrim-btn')).toHaveAttribute('aria-pressed', 'false');

  const cb = await page.locator('#select-canvas').boundingBox();
  if (!cb) throw new Error('select-canvas has no bounding box');

  // Small interior box (well clear of any corner) to get a valid drag
  // started at all.
  await page.mouse.move(cb.x + 20, cb.y + 20);
  await page.mouse.down();
  await page.mouse.move(cb.x + 60, cb.y + 60, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('#select-rect')).toBeVisible();

  // Grab the nw handle (box's current top-left corner) and drag it past the
  // canvas's top-left edge -- clamps to exactly canvas-local (0,0).
  let box = await page.locator('#select-rect').boundingBox();
  if (!box) throw new Error('select-rect has no bounding box');
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(cb.x - 50, cb.y - 50, { steps: 5 });
  await page.mouse.up();

  // Grab the se handle (box's current bottom-right corner) and drag it past
  // the canvas's bottom-right edge -- clamps to exactly canvas-local
  // (canvas.width, canvas.height).
  box = await page.locator('#select-rect').boundingBox();
  if (!box) throw new Error('select-rect has no bounding box');
  await page.mouse.move(box.x + box.width, box.y + box.height);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width + 50, cb.y + cb.height + 50, { steps: 5 });
  await page.mouse.up();

  await page.locator('#select-confirm-btn').click();
  await waitForFileReady(page);
}

async function selectUpscale(page: Page, value: '1' | '2') {
  await page.locator('#upscale-factor').selectOption(value);
}

test.describe('bilinear-2x path (issue #34) -- happy path', () => {
  test('an image below BILINEAR_NATIVE_SAFE_LIMIT that went through the selection flow traces via bilinear-2x, doubling the mask', async ({ page }) => {
    // select-sheet.png (512x512) is well above SELECT_SKIP_MAX_DIM (256,
    // js/app.js) -- confirmed by tests/selection.spec.ts -- so this genuinely
    // exercises the selection flow, then bilinear-2x on the confirmed crop.
    // Full-canvas selection (no auto-trim) keeps the final traced size an
    // exact, known 512x512 rather than an approximated subject bbox.
    await uploadFullCanvasSelection(page, SMALL_FIXTURE);
    await selectUpscale(page, '2');

    await traceAndExpectStatus(page, 'Done — SVG ready ✓', /ok/);

    // Proves bilinear specifically ran (not the Scale2x fallback, not a
    // silent no-op) and doubled the mask to the expected 1024x1024.
    await expect(page.locator('#svg-meta')).toContainText('Supersample: 2× bilinear (1024×1024)');

    // Second, independent confirmation straight from the exported SVG:
    // viewBox in mask-pixel units, width/height pinned back to native.
    const svg = page.locator('.prev-card-body.on-light svg').first();
    await expect(svg).toHaveAttribute('viewBox', '0 0 1024 1024');
    await expect(svg).toHaveAttribute('width', '512');
    await expect(svg).toHaveAttribute('height', '512');

    await expect(page.locator('#svg-result')).toBeVisible();
  });

  test('with upscaling off, no Supersample chip appears and the mask stays native', async ({ page }) => {
    await uploadFullCanvasSelection(page, SMALL_FIXTURE);
    await selectUpscale(page, '1');

    await traceAndExpectStatus(page, 'Done — SVG ready ✓', /ok/);

    await expect(page.locator('#svg-meta')).not.toContainText('Supersample');
    const svg = page.locator('.prev-card-body.on-light svg').first();
    await expect(svg).toHaveAttribute('viewBox', '0 0 512 512');
  });
});

test.describe('native-resolution fallback at BILINEAR_NATIVE_SAFE_LIMIT (issue #34)', () => {
  test('just below the gate (3499px), bilinear-2x still runs -- the gate does not fire early', async ({ page }) => {
    test.slow(); // real Worker round-trip on a ~3499x3499 image, not mocked

    await page.addInitScript(() => {
      (window as any).__workerConstructCount = 0;
      const OrigWorker = window.Worker;
      // @ts-ignore -- test-only instrumentation
      window.Worker = new Proxy(OrigWorker, {
        construct(target, args) {
          (window as any).__workerConstructCount++;
          // eslint-disable-next-line new-cap
          return new (target as any)(...args);
        },
      });
    });

    await uploadFullCanvasSelection(page, BELOW_GATE_FIXTURE);
    await selectUpscale(page, '2');

    // No "too large" advisory at this size -- the gate must not fire early.
    await expect(page.locator('#supersample-advisory')).toBeHidden();

    await traceAndExpectStatus(page, 'Done — SVG ready ✓', /ok/, 30000);

    await expect(page.locator('#svg-meta')).toContainText('Supersample: 2× bilinear (6998×6998)');
    const workerCount = await page.evaluate(() => (window as any).__workerConstructCount);
    expect(workerCount).toBe(1);
  });

  test('at the 3500px native-size gate, no Worker is constructed and the trace runs correctly at native resolution with no upscale', async ({ page }) => {
    // Tracks every window.Worker construction from inside the page, before
    // any app script runs, so this observes the real production code path
    // (js/app.js's unconditional `if (longestNative >= BILINEAR_NATIVE_SAFE_LIMIT)`
    // gate never even reaching `new Worker('js/bilinear-worker.js')`) rather
    // than inferring it indirectly.
    await page.addInitScript(() => {
      (window as any).__workerConstructCount = 0;
      const OrigWorker = window.Worker;
      // @ts-ignore -- test-only instrumentation
      window.Worker = new Proxy(OrigWorker, {
        construct(target, args) {
          (window as any).__workerConstructCount++;
          // eslint-disable-next-line new-cap
          return new (target as any)(...args);
        },
      });
    });

    await uploadFullCanvasSelection(page, AT_GATE_FIXTURE);
    await selectUpscale(page, '2'); // request 2x -- the gate must override this, not the user's choice

    // The pre-trace advisory (js/app.js updateSupersampleAdvisory) fires as
    // soon as the native size is known, independent of the trace itself --
    // confirms the gate's size check is keyed off the real native
    // dimensions of this fixture, not some other path.
    await expect(page.locator('#supersample-advisory')).toBeVisible();
    await expect(page.locator('#supersample-advisory')).toContainText('2× supersampling will be skipped');

    await traceAndExpectStatus(
      page,
      'Large image — tracing at native resolution, 2× supersampling skipped. SVG ready ✓',
      /warn/,
      30000
    );

    // No Supersample chip at all -- upscaleFactor came back 1, proving the
    // mask genuinely stayed native (not merely "some fallback ran").
    await expect(page.locator('#svg-meta')).not.toContainText('Supersample');
    const svg = page.locator('.prev-card-body.on-light svg').first();
    await expect(svg).toHaveAttribute('viewBox', '0 0 3500 3500');
    await expect(svg).toHaveAttribute('width', '3500');
    await expect(svg).toHaveAttribute('height', '3500');

    // The real assertion for "no Worker of any kind was attempted" -- not
    // "the trace happened to still work."
    const workerCount = await page.evaluate(() => (window as any).__workerConstructCount);
    expect(workerCount).toBe(0);

    // "Correct trace," not just "didn't crash": the fixture's centered
    // black square is 40% of the side length -> 16% fill, comfortably
    // bounded away from 0% (empty/blank mask) and 100% (inverted/solid).
    await expect(page.locator('#svg-meta')).toContainText(/Coverage:\s*1[0-9]%|Coverage:\s*2[0-2]%/);
    await expect(page.locator('#svg-meta')).not.toContainText('Paths: 0');
  });
});

test.describe('3x/4x upscale options regression guard (issue #34)', () => {
  test('the upscale-factor control only offers Off/2x -- 3x and 4x never reappear', async ({ page }) => {
    await page.goto('http://localhost:4321');

    const options = page.locator('#upscale-factor option');
    await expect(options).toHaveCount(2);

    const values = await options.evaluateAll(els => els.map(el => (el as HTMLOptionElement).value));
    expect(values).toEqual(['1', '2']);

    const labels = await options.evaluateAll(els => els.map(el => el.textContent));
    expect(labels).toEqual(['Off', '2×']);

    // No stray 3/4 value anywhere in the control, in case a future change
    // reintroduces them under different casing/formatting than '3'/'4'.
    for (const v of values) {
      expect(['1', '2']).toContain(v);
    }

    // The tooltip copy itself asserts the 2x cap, not just the option list
    // -- guards against the copy silently drifting out of sync with the
    // actual capability if the <select> options changed but the info text
    // didn't (or vice versa).
    const tip = page.locator('#tip-upscale-factor');
    await expect(tip).toContainText('Capped at 2×');
    await expect(tip).toContainText('very large images');
  });
});

test.describe('bilinear-presupersample Worker failure handling (issue #34)', () => {
  test('a Worker construction failure falls back to Scale2x-2x and surfaces a visible status, not a hang or silent failure', async ({ page }) => {
    // Simulates the exact failure js/app.js's runBilinearWorker try/catch
    // around `new Worker(...)` is written to catch (js/app.js ~1740-1745).
    await page.addInitScript(() => {
      // @ts-ignore -- test-only stub
      window.Worker = class {
        constructor() {
          throw new Error('simulated Worker construction failure');
        }
      };
    });

    await uploadFullCanvasSelection(page, SMALL_FIXTURE);
    await selectUpscale(page, '2');

    await traceAndExpectStatus(
      page,
      'Image too large for 2× supersampling — traced at native resolution instead. SVG ready ✓',
      /warn/
    );

    // Not a silent/degraded result -- the pipeline still produced a real,
    // usable SVG via the Scale2x-2x downgrade path (js/app.js ~1622-1628),
    // distinguishable from bilinear's success chip by its own label and
    // still doubling the mask exactly like bilinear would have.
    await expect(page.locator('#svg-meta')).toContainText('Supersample: 2× Scale2x (native fallback) (1024×1024)');
    await expect(page.locator('#svg-result')).toBeVisible();
  });

  test('a hung Worker (no response) times out and falls back rather than stalling the trace indefinitely', async ({ page }) => {
    test.slow(); // real BILINEAR_WORKER_TIMEOUT_MS is 20s (js/app.js) -- this test waits it out for real rather than mocking timers, to pin the actual production constant's behavior.

    await page.addInitScript(() => {
      // @ts-ignore -- test-only stub: constructs successfully but never
      // calls onmessage/onerror, forcing runBilinearWorker's setTimeout
      // safety net (js/app.js BILINEAR_WORKER_TIMEOUT_MS) to be the only
      // thing that can resolve this promise.
      window.Worker = class {
        postMessage() { /* never respond */ }
        terminate() { /* no-op */ }
      };
    });

    await uploadFullCanvasSelection(page, SMALL_FIXTURE);
    await selectUpscale(page, '2');

    await page.locator('#trace-btn').click();
    // Must not resolve early/incorrectly -- still mid-trace well before the
    // 20s timeout, proving the eventual fallback is genuinely the timeout
    // firing and not some other faster error path this stub accidentally
    // triggered.
    await page.waitForTimeout(3000);
    await expect(page.locator('#status')).not.toHaveText(/SVG ready/);

    await expect(page.locator('#status')).toHaveText(
      'Image too large for 2× supersampling — traced at native resolution instead. SVG ready ✓',
      { timeout: 25000 }
    );
    await expect(page.locator('#status')).toHaveClass(/warn/);
    await expect(page.locator('#svg-result')).toBeVisible();
  });
});
