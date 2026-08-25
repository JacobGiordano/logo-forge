import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Coverage for issue #40 -- Photoshop-style Levels adjustment (black point /
// white point / gamma), applied to the continuous luminance value upstream
// of Otsu/threshold resolution (js/app.js applyLevels(), consumed inside
// preprocessImageData). Wired through the same declarative CONTROL_DEFS
// mechanism every other slider uses, so it should already participate in
// live-preview debounce, undo/redo, and the numeric-input clamp/commit path
// without any new listener code -- this file pins that those three actually
// hold for the new controls specifically, plus that each control has a real,
// measurable effect on the traced output (not just wired-but-inert).
//
// tests/fixtures/gray-gradient.png (240x120, new) is a flat horizontal
// grayscale ramp, black (x=0) to white (x=width-1), constant down each
// column -- built with the same pure-Node PNG encoder used for this issue's
// sibling fixtures (see tests/small-source-smoothing.spec.ts's header
// comment for why: no canvas/native image lib in this repo's node_modules).
// Under SELECT_SKIP_MAX_DIM (256) so upload skips straight to the
// immediate-trace-ready flow, same convention as test-logo.png. A clean
// monotonic ramp gives Levels' remap an unambiguous input: measuring
// Coverage (js/app.js countFilledPixels/coverage, shown in #svg-meta) at a
// FIXED manual threshold isolates each control's effect from Otsu's own
// auto-threshold, which would otherwise partly re-adjust itself around
// whatever Levels did and mask the change.
//
// Verified against the pre-#40 code (commit 32aae17^, i.e. right after #39)
// with today's index.html (sliders present) before writing the
// coverage-change assertions below: with app.js's wiring absent, adjusting
// any of the three sliders left Coverage pinned at exactly the untouched
// baseline (50%) every time -- confirming these assertions actually catch a
// "control renders but does nothing" regression, not just a missing-DOM one.

const GRADIENT_FIXTURE = path.resolve(__dirname, 'fixtures/gray-gradient.png');
const FIXTURE = path.resolve(__dirname, 'fixtures/test-logo.png');

async function setManualThreshold(page: Page, value: string) {
  await page.locator('#threshold-mode').selectOption('manual');
  await page.locator('#threshold').fill(value);
}

async function traceAndReadCoveragePct(page: Page): Promise<number> {
  await page.locator('#trace-btn').click();
  await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
  const meta = await page.locator('#svg-meta').textContent();
  const m = meta && meta.match(/Coverage:\s*(\d+)%/);
  if (!m) throw new Error('could not read Coverage from #svg-meta: ' + meta);
  return parseInt(m[1], 10);
}

async function setNumericSlider(page: Page, id: string, value: string) {
  await page.locator('#v-' + id).fill(value);
  await page.locator('#v-' + id).press('Enter');
  await expect(page.locator('#' + id)).toHaveValue(value);
}

test.describe('Levels controls render with correct defaults (issue #40)', () => {
  test('black point, white point, and gamma sliders have correct default value/min/max/step', async ({ page }) => {
    await page.goto('http://localhost:4321');

    await expect(page.locator('#levels-black')).toHaveValue('0');
    await expect(page.locator('#levels-black')).toHaveAttribute('min', '0');
    await expect(page.locator('#levels-black')).toHaveAttribute('max', '255');
    await expect(page.locator('#levels-black')).toHaveAttribute('step', '1');
    await expect(page.locator('#v-levels-black')).toHaveValue('0');

    await expect(page.locator('#levels-white')).toHaveValue('255');
    await expect(page.locator('#levels-white')).toHaveAttribute('min', '0');
    await expect(page.locator('#levels-white')).toHaveAttribute('max', '255');
    await expect(page.locator('#levels-white')).toHaveAttribute('step', '1');
    await expect(page.locator('#v-levels-white')).toHaveValue('255');

    await expect(page.locator('#levels-gamma')).toHaveValue('1');
    await expect(page.locator('#levels-gamma')).toHaveAttribute('min', '0.1');
    await expect(page.locator('#levels-gamma')).toHaveAttribute('max', '3');
    await expect(page.locator('#levels-gamma')).toHaveAttribute('step', '0.1');
    await expect(page.locator('#v-levels-gamma')).toHaveValue('1.0');
  });
});

test.describe('each Levels control measurably changes the traced output (issue #40)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:4321');
    await page.locator('#file-input').setInputFiles(GRADIENT_FIXTURE);
    await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
    // Fixed manual threshold -- see header comment for why auto/Otsu would
    // partly self-correct around a Levels change and blur the assertion.
    await setManualThreshold(page, '128');
  });

  test('baseline: an untouched linear ramp at threshold 128 covers ~half the image', async ({ page }) => {
    const coverage = await traceAndReadCoveragePct(page);
    // x=0..239 maps darkest->lightest; threshold 128 should split it close
    // to the middle. Loose bound -- this test only pins the baseline other
    // tests in this file diff against, not an exact rounding value.
    expect(coverage).toBeGreaterThan(40);
    expect(coverage).toBeLessThan(60);
  });

  test('raising the black point measurably changes coverage against a fixed threshold', async ({ page }) => {
    const baseline = await traceAndReadCoveragePct(page);

    await setNumericSlider(page, 'levels-black', '200');
    const afterBlack = await traceAndReadCoveragePct(page);

    // Measured against this exact fixture/threshold: baseline ~50%, black
    // point 200 -> ~11% (verified by running this in a real browser before
    // asserting -- not hand-derived, since applyLevels' clamp-then-remap
    // interacts with buildMask's dark<threshold convention in a way that
    // isn't safe to eyeball). Loose bound: the real assertion is "measurably
    // different," not the exact number.
    expect(afterBlack).not.toBe(baseline);
    expect(Math.abs(afterBlack - baseline)).toBeGreaterThan(10);
  });

  test('lowering the white point measurably changes coverage against a fixed threshold', async ({ page }) => {
    const baseline = await traceAndReadCoveragePct(page);

    await setNumericSlider(page, 'levels-white', '100');
    const afterWhite = await traceAndReadCoveragePct(page);

    // Measured: baseline ~50% -> white point 100 -> ~80%.
    expect(afterWhite).not.toBe(baseline);
    expect(Math.abs(afterWhite - baseline)).toBeGreaterThan(10);
  });

  test('raising gamma above 1 measurably changes coverage against a fixed threshold', async ({ page }) => {
    const baseline = await traceAndReadCoveragePct(page);

    await setNumericSlider(page, 'levels-gamma', '2.5');
    const afterGamma = await traceAndReadCoveragePct(page);

    // Measured: baseline ~50% -> gamma 2.5 -> ~82%.
    expect(afterGamma).not.toBe(baseline);
    expect(Math.abs(afterGamma - baseline)).toBeGreaterThan(10);
  });

  test('black point and white point produce measurably different coverage from each other', async ({ page }) => {
    await setNumericSlider(page, 'levels-black', '200');
    const afterBlack = await traceAndReadCoveragePct(page);

    await page.reload();
    await page.locator('#file-input').setInputFiles(GRADIENT_FIXTURE);
    await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
    await setManualThreshold(page, '128');
    await setNumericSlider(page, 'levels-white', '100');
    const afterWhite = await traceAndReadCoveragePct(page);

    // Black point and white point remap opposite ends of the ramp -- they
    // should not coincidentally land on the same coverage number (measured:
    // ~11% vs ~80% against this fixture/threshold).
    expect(afterBlack).not.toBe(afterWhite);
  });
});

test.describe('undo/redo round-trips a Levels change (issue #40)', () => {
  async function uploadAndTrace(page: Page) {
    await page.goto('http://localhost:4321');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
    await page.locator('#trace-btn').click();
    await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
  }

  test('undo restores the pre-change white-point value and retraces to the original result; redo restores the change', async ({ page }) => {
    await uploadAndTrace(page); // history entry #1, levels-white = 255 (default)

    await setNumericSlider(page, 'levels-white', '150');
    await page.locator('#trace-btn').click();
    await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
    const changedMeta = await page.locator('#svg-meta').textContent();

    await page.locator('#undo-btn').click();
    await expect(page.locator('#levels-white')).toHaveValue('255');
    await expect(page.locator('#v-levels-white')).toHaveValue('255');
    await expect(page.locator('#status')).toHaveText('Restored — SVG ready ✓');

    await page.locator('#redo-btn').click();
    await expect(page.locator('#levels-white')).toHaveValue('150');
    await expect(page.locator('#v-levels-white')).toHaveValue('150');
    const redoneMeta = await page.locator('#svg-meta').textContent();
    expect(redoneMeta).toBe(changedMeta);
  });
});

test.describe('Levels sliders participate in the live-preview debounce (issue #40)', () => {
  test('rapid successive changes to levels-white coalesce into exactly one retrace after the debounce window', async ({ page }) => {
    await page.goto('http://localhost:4321');
    await page.locator('#file-input').setInputFiles(FIXTURE);
    await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
    await page.locator('#trace-btn').click(); // history entry #1
    await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
    await expect(page.locator('#undo-btn')).toBeDisabled();

    // #live-toggle defaults on (index.html) -- no need to enable it. Mutate
    // the slider 3x within one tick (mirrors tests/potrace.spec.ts's
    // near-simultaneous-trigger technique) to simulate a fast drag.
    await page.evaluate(() => {
      const el = document.getElementById('levels-white') as HTMLInputElement;
      el.value = '240'; el.dispatchEvent(new Event('input', { bubbles: true }));
      el.value = '220'; el.dispatchEvent(new Event('input', { bubbles: true }));
      el.value = '210'; el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // scheduleLive()'s debounce is 350ms (js/app.js) -- well before it
    // fires, still only the one manual trace's history entry.
    await page.waitForTimeout(150);
    await expect(page.locator('#undo-btn')).toBeDisabled();

    // After it fires, exactly one new (live) trace ran.
    await page.waitForTimeout(500);
    await expect(page.locator('#undo-btn')).toBeEnabled();

    await page.locator('#undo-btn').click();
    // If 3 separate retraces had fired instead of one coalesced retrace,
    // undo would land on an intermediate value (240 or 220), not all the
    // way back at the pre-change baseline.
    await expect(page.locator('#levels-white')).toHaveValue('255');
  });
});
