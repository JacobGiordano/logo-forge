import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Coverage for issue #17, the three gaps flagged in HANDOFF.md after #11-#16
// (binary tracer swapped to potrace-wasm, tuned):
//   1. Fallback path: WebAssembly unavailable -> imagetracer.js chain still works
//   2. Load-timing race: trace-btn clicked before potrace-wasm's dynamic
//      import() has settled -> resolves exactly once, no duplicate history
//   3. Vector-fit slider range coverage for #corner-smoothing/#curve-fit
//      (now driving potrace's alphamax/opttolerance, see js/app.js
//      cornerSmoothingToAlphamax()/curveFitToOpttolerance())
//
// tests/fixtures/test-logo.png (the checkerboard) is deliberately still used
// throughout, including the slider sweeps: it's confirmed (#16) to have zero
// curvature and stays byte-identical across curve-fit's whole range
// regardless of tuning, which is a real geometric property of that fixture,
// not a bug. These sweeps assert completion-without-error/hang across the
// range, not output sensitivity -- see the "vector-fit slider range
// coverage" describe block below.

const FIXTURE = path.resolve(__dirname, 'fixtures/test-logo.png');

async function waitForFileReady(page: Page) {
  await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
}

async function traceAndExpectDone(page: Page) {
  await page.locator('#trace-btn').click();
  await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
}

async function setNumericSlider(page: Page, id: string, value: string) {
  await page.locator('#v-' + id).fill(value);
  await page.locator('#v-' + id).press('Enter');
  await expect(page.locator('#' + id)).toHaveValue(value);
}

test.describe('potrace-wasm fallback', () => {
  test('falls back to the built-in tracer and still completes when WebAssembly is unavailable', async ({ page }) => {
    const fallbackWarnings: string[] = [];
    page.on('console', msg => {
      if (msg.text().includes('potrace-wasm unavailable, falling back to built-in tracer')) {
        fallbackWarnings.push(msg.text());
      }
    });

    // Stub WebAssembly away before ANY page script runs (same technique used
    // to manually verify this fallback during #14), so
    // PotraceTrace.isSupported() reports false and the trace handler's inner
    // try/catch (js/app.js ~1093-1106) takes the imagetracer.js fallback
    // branch instead of the potrace-wasm one.
    await page.addInitScript(() => { delete (window as any).WebAssembly; });
    await page.goto('http://localhost:4321');

    await page.locator('#file-input').setInputFiles(FIXTURE);
    await waitForFileReady(page);
    await traceAndExpectDone(page);

    await expect(page.locator('#svg-result')).toBeVisible();

    // Not just "it completed" -- prove the fallback branch specifically ran,
    // and ran for the reason we forced (WebAssembly missing), not some
    // unrelated potrace failure that happened to also fall back.
    expect(fallbackWarnings).toHaveLength(1);
    expect(fallbackWarnings[0]).toContain('WebAssembly not supported');
  });
});

test.describe('potrace-wasm load-timing race', () => {
  test('trace clicked immediately after upload (before the module settles) resolves exactly once', async ({ page }) => {
    let wasmRequestCount = 0;
    // Delay the vendored module's fetch so the window in which handleFile's
    // opportunistic PotraceTrace.warm() and the trace-btn click's own
    // PotraceTrace.trace() call are BOTH racing the same in-flight load is
    // wide and deterministic, rather than relying on it happening to still
    // be loading on a fast local dev server (see js/potrace-trace.js
    // loadModule()'s "concurrent callers share the same in-flight promise"
    // memoization comment -- this is the exact behavior under test).
    await page.route('**/potrace-wasm.js', async route => {
      wasmRequestCount++;
      await new Promise(r => setTimeout(r, 400));
      await route.continue();
    });

    const fallbackWarnings: string[] = [];
    page.on('console', msg => {
      if (msg.text().includes('falling back to built-in tracer')) fallbackWarnings.push(msg.text());
    });

    await page.goto('http://localhost:4321');
    await page.locator('#file-input').setInputFiles(FIXTURE); // fires PotraceTrace.warm()
    await waitForFileReady(page);

    // The critical part: click immediately, with no wait/warm-up, while the
    // 400ms-delayed module load kicked off by warm() above is still pending.
    await traceAndExpectDone(page);

    // Exactly one network fetch of the module despite two concurrent callers
    // (warm() at upload time, trace() at click time) -- proves the
    // memoization actually shared the in-flight promise instead of the two
    // callers racing two separate loads/inits.
    expect(wasmRequestCount).toBe(1);
    // It genuinely resolved via potrace-wasm once the delayed load settled,
    // not a silent fallback caused by contention between the two callers.
    expect(fallbackWarnings).toHaveLength(0);
    // Exactly one trace ran -- one history entry. Same shape of assertion as
    // the #10 liveTimer regression (a stray second trigger pushing a
    // duplicate, unrequested entry onto the undo/redo stack).
    await expect(page.locator('#undo-btn')).toBeDisabled();
    await expect(page.locator('#redo-btn')).toBeDisabled();
  });

  test('two near-simultaneous trace triggers before the module settles still produce exactly one trace', async ({ page }) => {
    await page.route('**/potrace-wasm.js', async route => {
      await new Promise(r => setTimeout(r, 400));
      await route.continue();
    });

    await page.goto('http://localhost:4321');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await waitForFileReady(page);

    // Two clicks fired back-to-back inside a single evaluate call, bypassing
    // Playwright's normal serialized actionability waits, to simulate a
    // genuine near-simultaneous double-trigger (e.g. a stray scheduleLive()
    // auto-click racing a manual click, the exact shape of the #10 bug)
    // rather than two safely-sequenced Playwright actions that would never
    // land in the same tick.
    await page.evaluate(() => {
      const btn = document.getElementById('trace-btn') as HTMLButtonElement;
      btn.click();
      btn.click();
    });

    await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
    // Give any stray second trace time to resolve if one snuck through
    // before asserting history state.
    await page.waitForTimeout(500);

    await expect(page.locator('#undo-btn')).toBeDisabled();
    await expect(page.locator('#redo-btn')).toBeDisabled();
  });
});

test.describe('vector-fit slider range coverage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:4321');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await waitForFileReady(page);
  });

  test('corner-smoothing sweep across its full range (0-4) completes without error', async ({ page }) => {
    for (const v of ['0', '1', '2', '3', '4']) {
      await setNumericSlider(page, 'corner-smoothing', v);
      await traceAndExpectDone(page);
    }
  });

  test('curve-fit sweep across its full range (0.1-6) completes without error', async ({ page }) => {
    for (const v of ['0.1', '1', '3', '6']) {
      await setNumericSlider(page, 'curve-fit', v);
      await traceAndExpectDone(page);
    }
  });

  test('combined corner-smoothing/curve-fit extremes complete without error or hang', async ({ page }) => {
    // Per HANDOFF.md's lesson from #16 (the two "Vector fit" sliders hid a
    // bug when only tested in isolation at the other's default) -- sweep
    // extremes of BOTH together, not just each slider alone.
    const combos: [string, string][] = [
      ['0', '0.1'], // both minimum
      ['4', '6'],   // both maximum
      ['0', '6'],   // min corner-smoothing, max curve-fit
      ['4', '0.1'], // max corner-smoothing, min curve-fit
    ];
    for (const [corner, curve] of combos) {
      await setNumericSlider(page, 'corner-smoothing', corner);
      await setNumericSlider(page, 'curve-fit', curve);
      await traceAndExpectDone(page);
    }
  });
});
