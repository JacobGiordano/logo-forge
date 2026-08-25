import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Regression coverage for issue #39: smoothMask's 3x3 majority-vote
// thresholds and the fixed despeckleNative default (24) were both tuned
// against "normal"-sized sources. At low native resolution, a straight
// 1px-wide stroke pixel only ever scores sum=3 in smoothMask's vote (itself
// + the two neighbors along the stroke), which the pre-#39 "survive at
// sum>=4" rule deleted outright, and a 1px gap between two adjacent shapes
// scores sum=6 on the flip-to-foreground side, which the pre-#39 "flip at
// sum>=6" rule bridged into a false join. #39 (js/app.js) introduces
// SMALL_SOURCE_DIM (256, reusing SELECT_SKIP_MAX_DIM's existing cutoff):
// below it, smoothMask relaxes the survive vote to sum>=3 and tightens the
// flip vote to sum>=7; at/above it, both stay byte-for-byte unchanged.
//
// tests/fixtures/thin-strokes-small.png (42x55, new) and
// tests/fixtures/thin-strokes-normal.png (256x256, new) are both a pure
// white background with two 1px-wide vertical black strokes (35px / 176px
// tall respectively) separated by exactly a 1px white gap column -- built
// with a pure-Node PNG encoder (RGBA8, no filtering; no canvas/native image
// lib is present in this repo's node_modules, same constraint noted in
// tests/selection.spec.ts's and tests/bilinear.spec.ts's fixture comments;
// see git history for the generation script if it needs regenerating). Both
// strokes are well under the scaled despeckle threshold's deletion range at
// this size (~4px^2) in total area (35px/176px tall x 1px wide), so
// despeckle/removeSmallComponents is not what determines survival here --
// only smoothMask's per-pixel vote is under test. The 256x256 fixture sits
// exactly at SMALL_SOURCE_DIM/SELECT_SKIP_MAX_DIM's own boundary (both
// cutoffs use "<", so 256 is NOT small and also skips the selection UI,
// same immediate-trace flow as the small fixture -- keeping the two
// directly comparable) and pins that the relaxation does not leak to it.
//
// Both fixtures were verified against the pre-#39 code (commit 24b26ec^)
// before writing these assertions: on the small fixture, pre-#39 produced
// stroke pixels white (deleted) and the gap pixel black (bridged) -- the
// exact bug; on the 256 fixture, pre-#39 and post-#39 produce byte-identical
// mask output (both delete the stroke and bridge the gap), confirming the
// 256px case is a true no-op for this fix rather than an untested edge.
//
// All assertions read the actual processed-mask preview image
// (.mask-preview img, native mask-pixel resolution) rather than the
// potrace-wasm/imagetracer path/hole counts in #svg-meta -- the curve
// tracer's own path-splitting behavior on 1px features turned out to be a
// noisy, tracer-specific signal (verified while developing this test: the
// small fixture traces to 4 paths + 1 hole, not a clean 2, even once the
// strokes correctly survive), whereas the mask pixels are the exact,
// deterministic output of the mechanism issue #39 actually changed.

const SMALL_FIXTURE = path.resolve(__dirname, 'fixtures/thin-strokes-small.png');
const NORMAL_FIXTURE = path.resolve(__dirname, 'fixtures/thin-strokes-normal.png');

async function traceAndReadMaskPixels(page: Page, fixture: string, points: [number, number][]) {
  await page.goto('http://localhost:4321');
  await page.locator('#file-input').setInputFiles(fixture);
  await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
  // Default settings throughout -- no sliders touched. cornerSmoothing
  // defaults to 1 (index.html) so smoothMask's prePasses = max(1,
  // floor(1/2)) = 1 always runs even untouched, and despeckle defaults to
  // 24 -- this is deliberately the exact "did nothing special" repro shape
  // the issue itself reported (a plain upload-and-trace at defaults).
  await page.locator('#trace-btn').click();
  await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });

  const maskImg = page.locator('.mask-preview img');
  await expect(maskImg).toBeVisible();

  return page.evaluate(pts => {
    const imgEl = document.querySelector('.mask-preview img') as HTMLImageElement;
    const canvas = document.createElement('canvas');
    canvas.width = imgEl.naturalWidth;
    canvas.height = imgEl.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(imgEl, 0, 0);
    // maskToImageData (js/app.js): foreground (mask=1) -> rgb(0,0,0),
    // background (mask=0) -> rgb(255,255,255).
    return pts.map(([x, y]) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return d[0] < 128; // true = foreground (black), false = background (white)
    });
  }, points);
}

test.describe('small-source stroke survival and gap separation (issue #39)', () => {
  test('below SMALL_SOURCE_DIM: both 1px strokes survive and the 1px gap between them stays background (not bridged)', async ({ page }) => {
    // Sample several interior rows along each column, clear of the stroke's
    // own top/bottom endpoints (rows 10 and 44) where edge effects change
    // the vote sum -- see the fixture's own generation comment.
    const rows = [15, 20, 25, 30, 40];
    const points: [number, number][] = [
      ...rows.map((y): [number, number] => [15, y]), // stroke 1
      ...rows.map((y): [number, number] => [16, y]), // gap
      ...rows.map((y): [number, number] => [17, y]), // stroke 2
    ];

    const results = await traceAndReadMaskPixels(page, SMALL_FIXTURE, points);
    const stroke1 = results.slice(0, rows.length);
    const gap = results.slice(rows.length, rows.length * 2);
    const stroke2 = results.slice(rows.length * 2);

    expect(stroke1.every(fg => fg === true)).toBe(true);
    expect(stroke2.every(fg => fg === true)).toBe(true);
    expect(gap.every(fg => fg === false)).toBe(true);
  });

  test('the SVG itself reflects real, non-empty traced content at this size (not an empty result)', async ({ page }) => {
    await page.goto('http://localhost:4321');
    await page.locator('#file-input').setInputFiles(SMALL_FIXTURE);
    await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
    await page.locator('#trace-btn').click();
    await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });

    // Pre-#39, this exact fixture traces to a fully empty mask (0% coverage,
    // "Paths: 0") -- see this test file's header comment. Post-#39 it must
    // be genuinely non-empty.
    await expect(page.locator('#svg-meta')).not.toContainText('Coverage: 0%');
    await expect(page.locator('#svg-meta')).not.toContainText('Paths: 0');
    await expect(page.locator('#svg-result')).toBeVisible();
  });
});

test.describe('no regression at/above SMALL_SOURCE_DIM (issue #39 boundary)', () => {
  test('at exactly 256px native (the SMALL_SOURCE_DIM/SELECT_SKIP_MAX_DIM boundary), the old unrelaxed vote thresholds still apply', async ({ page }) => {
    // Same absolute 1px-stroke/1px-gap geometry as the small fixture, just
    // on a 256x256 canvas -- SMALL_SOURCE_DIM's `Math.min(width,height) <
    // 256` is false at exactly 256, so this must reproduce the OLD (pre-#39)
    // behavior verbatim: both stroke columns deleted, and the gap column
    // between them flipped to foreground by the (still-unrelaxed) flip vote
    // -- a real, if visually odd, artifact of both decisions being computed
    // from the same pre-pass mask snapshot in one smoothMask pass. This is
    // the exact pre-#39 output confirmed by running this fixture against
    // commit 24b26ec^ directly.
    const rows = [50, 100, 150, 200];
    const points: [number, number][] = [
      ...rows.map((y): [number, number] => [126, y]), // stroke 1
      ...rows.map((y): [number, number] => [127, y]), // gap
      ...rows.map((y): [number, number] => [128, y]), // stroke 2
    ];

    const results = await traceAndReadMaskPixels(page, NORMAL_FIXTURE, points);
    const stroke1 = results.slice(0, rows.length);
    const gap = results.slice(rows.length, rows.length * 2);
    const stroke2 = results.slice(rows.length * 2);

    expect(stroke1.every(fg => fg === false)).toBe(true); // deleted, unchanged from before #39
    expect(stroke2.every(fg => fg === false)).toBe(true);
    expect(gap.every(fg => fg === true)).toBe(true); // still bridges, unchanged from before #39
  });
});
