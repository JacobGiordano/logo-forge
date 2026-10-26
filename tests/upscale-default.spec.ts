import { test, expect } from '@playwright/test';
import path from 'path';

// Coverage for the "Upscale before trace defaults to 2x" change
// (upscale-default-2x branch): the dropdown starts at 2x, sources at/above
// SMALL_SOURCE_DIM (256) really supersample without the user touching it,
// and small sources (isSmallSource: min side < 256) skip 2x with a pre-trace
// advisory explaining why. The large-image advisory is covered in
// tests/bilinear.spec.ts.

const SMALL_FIXTURE = path.resolve(__dirname, 'fixtures/thin-strokes-small.png'); // 42x55
const BOUNDARY_FIXTURE = path.resolve(__dirname, 'fixtures/thin-strokes-normal.png'); // 256x256

test.describe('Upscale before trace defaults to 2x', () => {
  test('a 256px source traces at 2x without touching the dropdown, with no skip advisory', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#upscale-factor')).toHaveValue('2');

    await page.locator('#file-input').setInputFiles(BOUNDARY_FIXTURE);
    await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
    // Exactly 256 is not small (strict "<"), so nothing is skipped.
    await expect(page.locator('#supersample-advisory')).toBeHidden();

    await page.locator('#trace-btn').click();
    await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
    await expect(page.locator('#svg-meta')).toContainText('Supersample: 2× bilinear (512×512)');
    await expect(page.locator('.prev-card-body.on-light svg').first()).toHaveAttribute('viewBox', '0 0 512 512');
  });

  test('a small source shows the "image is small" advisory and traces at native resolution', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(SMALL_FIXTURE);
    await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });

    const advisory = page.locator('#supersample-advisory');
    await expect(advisory).toBeVisible();
    await expect(advisory).toHaveText('This image is small — 2× supersampling will be skipped and it will trace at native resolution.');

    await page.locator('#trace-btn').click();
    await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
    await expect(page.locator('#upscale-factor')).toHaveValue('2');
    await expect(page.locator('#svg-meta')).not.toContainText('Supersample');
    await expect(page.locator('.prev-card-body.on-light svg').first()).toHaveAttribute('viewBox', '0 0 42 55');
  });
});
