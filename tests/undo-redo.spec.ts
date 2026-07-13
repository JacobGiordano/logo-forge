import { test, expect, Page } from '@playwright/test';
import path from 'path';

const FIXTURE = path.resolve(__dirname, 'fixtures/test-logo.png');

async function uploadAndTrace(page: Page, threshold = '128') {
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });

  if (threshold !== '128') {
    await page.locator('#threshold').fill(threshold);
  }

  await page.locator('#trace-btn').click();
  await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('http://localhost:4321');
});

test('undo and redo buttons are disabled on load', async ({ page }) => {
  await expect(page.locator('#undo-btn')).toBeDisabled();
  await expect(page.locator('#redo-btn')).toBeDisabled();
});

test('undo disabled and redo disabled after first trace', async ({ page }) => {
  await uploadAndTrace(page);
  await expect(page.locator('#undo-btn')).toBeDisabled();
  await expect(page.locator('#redo-btn')).toBeDisabled();
});

test('undo enabled and redo disabled after two traces', async ({ page }) => {
  await uploadAndTrace(page, '100');
  await uploadAndTrace(page, '200');
  await expect(page.locator('#undo-btn')).toBeEnabled();
  await expect(page.locator('#redo-btn')).toBeDisabled();
});

test('redo enabled after undo', async ({ page }) => {
  await uploadAndTrace(page, '100');
  await uploadAndTrace(page, '200');
  await page.locator('#undo-btn').click();
  await expect(page.locator('#redo-btn')).toBeEnabled();
});

test('undo restores slider values', async ({ page }) => {
  // First trace at threshold 100
  await uploadAndTrace(page, '100');

  // Second trace at threshold 200
  await page.locator('#threshold').fill('200');
  await page.locator('#trace-btn').click();
  await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });

  // Undo → should go back to threshold 100
  await page.locator('#undo-btn').click();
  await expect(page.locator('#threshold')).toHaveValue('100');
  await expect(page.locator('#v-threshold')).toHaveText('100');
});

test('redo restores slider values after undo', async ({ page }) => {
  await uploadAndTrace(page, '100');

  await page.locator('#threshold').fill('200');
  await page.locator('#trace-btn').click();
  await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });

  await page.locator('#undo-btn').click();
  await page.locator('#redo-btn').click();

  await expect(page.locator('#threshold')).toHaveValue('200');
  await expect(page.locator('#v-threshold')).toHaveText('200');
});

test('new trace after undo clears redo history', async ({ page }) => {
  await uploadAndTrace(page, '100');
  await uploadAndTrace(page, '200');

  await page.locator('#undo-btn').click();
  await expect(page.locator('#redo-btn')).toBeEnabled();

  // Trace again — redo stack should clear
  await page.locator('#threshold').fill('150');
  await page.locator('#trace-btn').click();
  await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });

  await expect(page.locator('#redo-btn')).toBeDisabled();
});

test('Cmd+Z triggers undo', async ({ page }) => {
  await uploadAndTrace(page, '100');
  await uploadAndTrace(page, '200');

  await page.keyboard.press('Meta+z');
  await expect(page.locator('#threshold')).toHaveValue('100');
});

test('Cmd+Shift+Z triggers redo', async ({ page }) => {
  await uploadAndTrace(page, '100');
  await uploadAndTrace(page, '200');

  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+Shift+z');
  await expect(page.locator('#threshold')).toHaveValue('200');
});

test('SVG result is shown after undo', async ({ page }) => {
  await uploadAndTrace(page, '100');
  await uploadAndTrace(page, '200');
  await page.locator('#undo-btn').click();
  await expect(page.locator('#svg-result')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Restored — SVG ready ✓');
});

test('trace shows processed mask preview and richer diagnostics', async ({ page }) => {
  await uploadAndTrace(page);
  await expect(page.locator('#svg-meta')).toContainText('Threshold');
  await expect(page.locator('#preview-grid')).toContainText('Processed mask');
});
