import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Regression coverage for the two-tone auto-threshold fix (27be9f6,
// js/app.js computeOtsuThreshold). On a histogram with exactly two populated
// levels (flat ink on a flat background, no anti-aliasing), Otsu's
// between-class variance is the same for every t from the dark level up to
// just below the light one, so the search returned the dark level itself
// (0 for black, clamped to 1). At native resolution that still produced the
// right mask, but the 2x bilinear path interpolates grey edge samples
// between the two tones, and a threshold hugging the ink tone dropped them:
// every shape lost ~0.5 source px per side, and strokes that survived
// natively could vanish entirely. Grey ink was worse: with lum<50 as the
// rule, a rgb(50,50,50) logo traced empty even at Off. The fix returns
// ceil((lo+hi)/2) for two-tone histograms; anything with intermediate
// values takes the normal Otsu search unchanged.
//
// Verified against the pre-fix code (27be9f6^): tests 1-3 below fail there
// (auto 1 readout; 2x widths ~1 source px narrower; empty strokes at cs 0;
// grey ink traces empty), and the gradient test's "auto 127" readout is
// identical before and after the fix.
//
// Two-tone images are drawn in-test on a canvas with integer-aligned
// fillRect calls and opaque colors, then exported as PNG (lossless), so
// every pixel is exactly one of the two colors -- no anti-aliasing to make
// the histogram three-tone. 256x256 is deliberate: it is not a small source
// (isSmallSource uses "<"), so the 2x default really runs, and it also skips
// the selection UI (same immediate-trace flow as thin-strokes-normal.png).

const THIN_STROKES_NORMAL = path.resolve(__dirname, 'fixtures/thin-strokes-normal.png'); // 256x256
const GRADIENT_FIXTURE = path.resolve(__dirname, 'fixtures/gray-gradient.png'); // 240x120 ramp

type Upload = { name: string; mimeType: string; buffer: Buffer };

// Vertical strokes 1/2/3/4px wide at x=20/40/60/80 and a 100px square at
// x=130..229, all spanning the middle row (y=128).
async function makeTwoToneImage(page: Page, ink: string): Promise<Upload> {
  await page.goto('/');
  const b64 = await page.evaluate(inkColor => {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = inkColor;
    ctx.fillRect(20, 40, 1, 200);
    ctx.fillRect(40, 40, 2, 200);
    ctx.fillRect(60, 40, 3, 200);
    ctx.fillRect(80, 40, 4, 200);
    ctx.fillRect(130, 80, 100, 100);
    return c.toDataURL('image/png').split(',')[1];
  }, ink);
  return { name: 'two-tone.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

async function trace(page: Page, file: string | Upload, opts: { upscale?: '1' | '2'; cornerSmoothing?: string } = {}) {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
  if (opts.upscale) await page.locator('#upscale-factor').selectOption(opts.upscale);
  if (opts.cornerSmoothing !== undefined) {
    await page.locator('#v-corner-smoothing').fill(opts.cornerSmoothing);
    await page.locator('#v-corner-smoothing').press('Enter');
    await expect(page.locator('#corner-smoothing')).toHaveValue(opts.cornerSmoothing);
  }
  await page.locator('#trace-btn').click();
  await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
}

// Foreground runs along the middle row of the processed mask preview,
// converted to source-pixel units (mask px / scale) so a native run and a
// 2x run of the same shape compare directly. Returns [start, widthInSourcePx].
async function midRowRunsInSourcePx(page: Page, scale: number): Promise<[number, number][]> {
  return page.evaluate(s => {
    const img = document.querySelector('.mask-preview img') as HTMLImageElement;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const y = Math.floor(c.height / 2);
    const row = ctx.getImageData(0, y, c.width, 1).data;
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= c.width; x++) {
      const fg = x < c.width && row[x * 4] < 128; // maskToImageData: fg = black
      if (fg && start < 0) start = x;
      if (!fg && start >= 0) { runs.push([start / s, (x - start) / s]); start = -1; }
    }
    return runs;
  }, scale);
}

test.describe('two-tone auto threshold (midpoint fix)', () => {
  test('black-on-white at the 2x default: auto threshold is 128 and stroke/square widths match the Off trace', async ({ page }) => {
    const img = await makeTwoToneImage(page, '#000000');

    await trace(page, img, { upscale: '1' });
    await expect(page.locator('#svg-meta')).toContainText('(auto 128)');
    const native = await midRowRunsInSourcePx(page, 1);

    // No dropdown change: 2x is the default and 256px is not small.
    await trace(page, img);
    await expect(page.locator('#svg-meta')).toContainText('Supersample: 2× bilinear (512×512)');
    await expect(page.locator('#svg-meta')).toContainText('(auto 128)');
    const upscaled = await midRowRunsInSourcePx(page, 2);

    // Native: the 1px stroke is removed by the normal-size smoothMask vote
    // (issue #39 -- expected at 256px), the rest keep their full widths.
    expect(native).toEqual([[40, 2], [60, 3], [80, 4], [130, 100]]);
    // Pre-fix, 2x came out as [[40.5,1],[60.5,2],[80.5,3],[130.5,99]].
    expect(upscaled).toEqual(native);
  });

  test('thin-strokes-normal.png at corner smoothing 0 and 2x keeps both 1px strokes', async ({ page }) => {
    // Corner smoothing 0 skips smoothMask, so both strokes (x=126, x=128)
    // reach the bilinear stage; pre-fix, threshold 1 dropped every
    // interpolated stroke sample and the SVG had no paths at all.
    await trace(page, THIN_STROKES_NORMAL, { upscale: '2', cornerSmoothing: '0' });
    await expect(page.locator('#svg-meta')).toContainText('Supersample: 2× bilinear (512×512)');
    await expect(page.locator('#svg-meta')).toContainText('(auto 128)');

    const runs = await midRowRunsInSourcePx(page, 2);
    expect(runs).toEqual([[126, 1], [128, 1]]);
    await expect(page.locator('.prev-card-body.on-light svg path').first()).toBeAttached();
    await expect(page.locator('#svg-meta')).not.toContainText('Coverage: 0%');
  });

  test('grey ink (rgb 50) on white traces non-empty at Off with auto threshold 153', async ({ page }) => {
    // Pre-fix: auto 50, and buildMask's "lum < threshold" made every ink
    // pixel (lum exactly 50) background -- an empty trace even natively.
    const img = await makeTwoToneImage(page, 'rgb(50, 50, 50)');
    await trace(page, img, { upscale: '1' });
    await expect(page.locator('#svg-meta')).toContainText('(auto 153)');
    expect(await midRowRunsInSourcePx(page, 1)).toEqual([[40, 2], [60, 3], [80, 4], [130, 100]]);
    await expect(page.locator('.prev-card-body.on-light svg path').first()).toBeAttached();
  });

  test('a many-level image keeps its normal Otsu threshold (fix only applies to exactly two levels)', async ({ page }) => {
    // gray-gradient.png is a 240-step horizontal luminance ramp -- far more
    // than two populated bins -- so it must take the ordinary Otsu search.
    // "auto 127" is the readout both before (27be9f6^) and after the fix.
    await trace(page, GRADIENT_FIXTURE, { upscale: '1' });
    await expect(page.locator('#svg-meta')).toContainText('(auto 127)');
  });
});
