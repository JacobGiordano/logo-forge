import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Regression coverage for drop-to-replace (commit b852e9a). Before it,
// file drag-and-drop was handled only by #dropzone, which is display:none
// once an image is loaded — so dropping a second image fell through to the
// browser default and opened the file in a new tab. File drops are now
// handled at window level and routed through the same load path as the
// file inputs, and a "Drop to replace image" overlay shows while a file is
// dragged over the loaded app.
//
// Real OS drags can't be driven from Playwright, so these tests dispatch
// DragEvents carrying a DataTransfer with a real fixture File in it — the
// same shape the browser hands the page for an external file drag.
//
// Deliberately NOT covered here: what happens when a non-image file is
// dropped (that behavior is being changed separately).

const SMALL = 'test-logo.png';           // 32x32 — skips selection view
const REPLACEMENT = 'thin-strokes-normal.png'; // 256x256 — also skips it

function fixtureB64(name: string) {
  return fs.readFileSync(path.resolve(__dirname, 'fixtures', name)).toString('base64');
}

type Step = { type: string; target: string };

// Dispatches a sequence of drag events, all sharing one DataTransfer.
// kind 'file' carries an image File (types include 'Files'); kind 'text'
// carries only text/plain, like dragging selected text from another app.
// Returns, per step, whether the page called preventDefault — that is the
// observable that decides whether the browser runs its default action
// (navigating to the dropped file).
async function drag(page: Page, kind: 'file' | 'text', steps: Step[], fixture = REPLACEMENT) {
  const b64 = kind === 'file' ? fixtureB64(fixture) : '';
  return page.evaluate(({ kind, steps, b64, name }) => {
    const dt = new DataTransfer();
    if (kind === 'file') {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], name, { type: 'image/png' }));
    } else {
      dt.setData('text/plain', 'hello');
    }
    return steps.map(s => {
      const el = s.target === 'document' ? document : document.querySelector(s.target)!;
      const ev = new DragEvent(s.type, { bubbles: true, cancelable: true, dataTransfer: dt });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
  }, { kind, steps, b64, name: fixture });
}

const enter = (target: string) => ({ type: 'dragenter', target });
const over = (target: string) => ({ type: 'dragover', target });
const leave = (target: string) => ({ type: 'dragleave', target });
const drop = (target: string) => ({ type: 'drop', target });

// Counts how many times the app announces a completed load. A double load
// sets the "Loaded ..." status twice, so this sees it even when both loads
// are of the same file. Installed before the app script runs.
async function countLoads(page: Page) {
  await page.addInitScript(() => {
    (window as any).__loads = [];
    document.addEventListener('DOMContentLoaded', () => {
      const status = document.getElementById('status')!;
      new MutationObserver(() => {
        const t = status.textContent || '';
        if (t.startsWith('Loaded ')) (window as any).__loads.push(t);
      }).observe(status, { childList: true, characterData: true, subtree: true });
    });
  });
}

async function loadViaInput(page: Page, fixture = SMALL) {
  await page.locator('#file-input').setInputFiles(path.resolve(__dirname, 'fixtures', fixture));
  await expect(page.locator('#thumb-wrap')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('#status')).toHaveText(/^Loaded 32×32px/);
}

const overlay = (page: Page) => page.locator('#drop-overlay');

test.describe('drop to replace — after an image is loaded', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadViaInput(page);
  });

  test('dropping an image file anywhere on the page replaces the loaded image', async ({ page }) => {
    const prevented = await drag(page, 'file', [enter('body'), over('body'), drop('body')]);
    // The page claimed the drop, so the browser does not navigate away to
    // the file (the original bug).
    expect(prevented).toEqual([true, true, true]);
    await expect(page.locator('#status')).toHaveText(/^Loaded 256×256px/);
    await expect(page.locator('#thumb-img')).toHaveJSProperty('naturalWidth', 256);
    await expect(page.locator('#trace-btn')).toBeEnabled();
  });

  test('a drop over a nested element (not body) also replaces the image', async ({ page }) => {
    await drag(page, 'file', [enter('#thumb-wrap'), over('#thumb-wrap'), drop('#thumb-wrap')]);
    await expect(page.locator('#status')).toHaveText(/^Loaded 256×256px/);
  });

  test('overlay stays hidden when nothing is being dragged', async ({ page }) => {
    await expect(overlay(page)).toBeHidden();
    // Ordinary interaction with the loaded app doesn't summon it either.
    await page.mouse.move(200, 200);
    await page.mouse.move(400, 300, { steps: 5 });
    await page.locator('header').click({ position: { x: 5, y: 5 } });
    await expect(overlay(page)).toBeHidden();
  });

  test('overlay shows during a file drag and survives moving between child elements', async ({ page }) => {
    await drag(page, 'file', [enter('body'), over('body')]);
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toContainText('Drop to replace image');

    // Moving onto a child fires dragenter(child) then dragleave(parent);
    // the overlay must not flicker off in between.
    await drag(page, 'file', [enter('#thumb-wrap'), leave('body'), over('#thumb-wrap')]);
    await expect(overlay(page)).toBeVisible();
  });

  test('overlay hides when the drag leaves the window', async ({ page }) => {
    await drag(page, 'file', [enter('body'), enter('#thumb-wrap'), leave('body'), over('#thumb-wrap')]);
    await expect(overlay(page)).toBeVisible();
    // Leaving the last element under the cursor = leaving the window.
    await drag(page, 'file', [leave('#thumb-wrap')]);
    await expect(overlay(page)).toBeHidden();
    // And the image was not replaced by merely dragging over.
    await expect(page.locator('#status')).toHaveText(/^Loaded 32×32px/);
  });

  test('overlay hides on drop', async ({ page }) => {
    await drag(page, 'file', [enter('body'), over('body')]);
    await expect(overlay(page)).toBeVisible();
    await drag(page, 'file', [drop('body')]);
    await expect(overlay(page)).toBeHidden();
  });

  test('overlay hides on dragend (drag cancelled)', async ({ page }) => {
    await drag(page, 'file', [enter('body'), enter('#thumb-wrap'), over('#thumb-wrap')]);
    await expect(overlay(page)).toBeVisible();
    await drag(page, 'file', [{ type: 'dragend', target: 'document' }]);
    await expect(overlay(page)).toBeHidden();
  });

  test('a fresh file drag after a completed one shows the overlay again', async ({ page }) => {
    await drag(page, 'file', [enter('body'), over('body'), drop('body')]);
    await expect(page.locator('#status')).toHaveText(/^Loaded 256×256px/);
    await expect(overlay(page)).toBeHidden();
    await drag(page, 'file', [enter('body'), over('body')]);
    await expect(overlay(page)).toBeVisible();
  });

  test('text drags are not intercepted', async ({ page }) => {
    const prevented = await drag(page, 'text', [enter('body'), over('body'), drop('body')]);
    // Not claimed: the browser's normal handling of a text drag applies.
    expect(prevented).toEqual([false, false, false]);
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('#status')).toHaveText(/^Loaded 32×32px/);
  });

  test('a drag that started inside the page (e.g. the thumbnail) is not treated as a file drop', async ({ page }) => {
    // Chrome reports a dragged <img> with a 'Files' type too; an in-page
    // dragstart is what tells it apart from an external file drag.
    await page.locator('#thumb-img').dispatchEvent('dragstart');
    const prevented = await drag(page, 'file', [enter('body'), over('body'), drop('body')]);
    expect(prevented).toEqual([false, false, false]);
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('#status')).toHaveText(/^Loaded 32×32px/);

    // Once that in-page drag ends, external file drags work again.
    await drag(page, 'file', [{ type: 'dragend', target: 'document' }]);
    await drag(page, 'file', [enter('body'), over('body'), drop('body')]);
    await expect(page.locator('#status')).toHaveText(/^Loaded 256×256px/);
  });
});

test.describe('drop to replace — before any image is loaded', () => {
  test('a file drag over the empty app does not show the replace overlay', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#dropzone')).toBeVisible();
    await drag(page, 'file', [enter('#dropzone'), over('#dropzone')]);
    // The dropzone itself is the cue while it is showing.
    await expect(overlay(page)).toBeHidden();
  });

  test('dropping a file on #dropzone loads it exactly once', async ({ page }) => {
    await countLoads(page);
    await page.goto('/');
    const prevented = await drag(page, 'file', [enter('#dropzone'), over('#dropzone'), drop('#dropzone')], SMALL);
    expect(prevented).toEqual([true, true, true]);
    await expect(page.locator('#thumb-wrap')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#status')).toHaveText(/^Loaded 32×32px/);
    await expect(overlay(page)).toBeHidden();
    // Give a hypothetical second load (from a second drop handler) ample
    // time to land before counting.
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as any).__loads)).toEqual(['Loaded 32×32px — ready to trace']);
  });

  test('text drags over the dropzone are not intercepted', async ({ page }) => {
    await page.goto('/');
    const prevented = await drag(page, 'text', [enter('#dropzone'), over('#dropzone'), drop('#dropzone')]);
    expect(prevented).toEqual([false, false, false]);
    await expect(page.locator('#dropzone')).toBeVisible();
    await expect(page.locator('#thumb-wrap')).toBeHidden();
  });
});
