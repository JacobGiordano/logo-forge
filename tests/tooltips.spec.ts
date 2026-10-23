import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Coverage for issue #33: the slider/setting info popovers added in #26 and
// the hover-scope fix in #28 (initInfoPopovers in js/app.js).
//
// Behavior under test, in user terms:
//   - Desktop: hovering the small "i" button previews its tip. Hovering or
//     dragging the slider / number input in the same row does NOT (#28).
//     Moving from the button down into the tip text keeps it open (a short
//     grace period covers the trip across the slider); leaving closes it.
//   - Click pins a tip open, click again unpins, clicking another "i"
//     closes the first, clicking outside or pressing Escape closes it.
//   - Touch (coarse pointer): tap pins/unpins; hover never opens anything.
//
// "Open" is asserted through the public surface the feature exposes:
// aria-expanded on the button and visibility of the paired .info-pop.

// Longer than the 200ms hover grace delay in initInfoPopovers, with margin
// for slow CI. Used where a test has to prove something stayed open (or
// stayed closed) after the grace period would have run out.
const PAST_GRACE_MS = 500;

const BLACK = { btn: 'button[aria-controls="tip-levels-black"]', pop: '#tip-levels-black', slider: '#levels-black', num: '#v-levels-black' };
const WHITE = { btn: 'button[aria-controls="tip-levels-white"]', pop: '#tip-levels-white' };

async function expectOpen(page: Page, t: { btn: string; pop: string }) {
  await expect(page.locator(t.btn)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(t.pop)).toBeVisible();
}

async function expectClosed(page: Page, t: { btn: string; pop: string }) {
  await expect(page.locator(t.btn)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator(t.pop)).toBeHidden();
}

// Same as expectClosed but checked once, right now, with no auto-retry —
// for asserting that something did NOT open (an auto-retrying assertion
// would pass trivially before a delayed open could happen).
async function expectClosedNow(page: Page, t: { btn: string; pop: string }) {
  expect(await page.locator(t.btn).getAttribute('aria-expanded')).toBe('false');
  expect(await page.locator(t.pop).isHidden()).toBe(true);
}

// A neutral spot with no popover-related listeners: the page header.
async function moveToNeutral(page: Page) {
  const box = await page.locator('header').boundingBox();
  if (!box) throw new Error('header has no bounding box');
  await page.mouse.move(box.x + 5, box.y + 5, { steps: 5 });
}

test.describe('info popovers — desktop mouse', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Precondition: this describe block is only meaningful with a fine
    // pointer, where the hover layer is wired up.
    expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(false);
    await expectClosedNow(page, BLACK);
  });

  test('hovering the info button opens its popover; moving away closes it', async ({ page }) => {
    await page.locator(BLACK.btn).hover();
    await expectOpen(page, BLACK);
    await moveToNeutral(page);
    await expectClosed(page, BLACK);
  });

  test('regression #28: hovering the slider or number input does not open the popover', async ({ page }) => {
    await page.locator(BLACK.slider).hover();
    await page.waitForTimeout(PAST_GRACE_MS);
    await expectClosedNow(page, BLACK);

    await page.locator(BLACK.num).hover();
    await page.waitForTimeout(PAST_GRACE_MS);
    await expectClosedNow(page, BLACK);
  });

  test('regression #28: dragging the slider does not open the popover', async ({ page }) => {
    const box = await page.locator(BLACK.slider).boundingBox();
    if (!box) throw new Error('slider has no bounding box');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, y, { steps: 10 });
    await page.mouse.up();
    // The drag really moved the slider (so this exercised a real drag).
    expect(Number(await page.locator(BLACK.slider).inputValue())).toBeGreaterThan(0);
    await page.waitForTimeout(PAST_GRACE_MS);
    await expectClosedNow(page, BLACK);
  });

  test('moving from the info button down into the popover text keeps it open', async ({ page }) => {
    await page.locator(BLACK.btn).hover();
    await expectOpen(page, BLACK);
    const popBox = await page.locator(BLACK.pop).boundingBox();
    if (!popBox) throw new Error('popover has no bounding box');
    // Travel across the slider row on the way down — the grace period is
    // what lets the tip survive this trip.
    await page.mouse.move(popBox.x + popBox.width / 2, popBox.y + popBox.height / 2, { steps: 10 });
    await page.waitForTimeout(PAST_GRACE_MS);
    await expectOpen(page, BLACK);

    // Leaving the popover itself closes it too.
    await moveToNeutral(page);
    await expectClosed(page, BLACK);
  });

  test('leaving the button onto the slider closes the popover after the grace period', async ({ page }) => {
    await page.locator(BLACK.btn).hover();
    await expectOpen(page, BLACK);
    await page.locator(BLACK.slider).hover();
    await page.waitForTimeout(PAST_GRACE_MS);
    await expectClosedNow(page, BLACK);
  });

  test('click pins the popover open after the mouse leaves; clicking again unpins', async ({ page }) => {
    await page.locator(BLACK.btn).click();
    await expectOpen(page, BLACK);
    await moveToNeutral(page);
    await page.waitForTimeout(PAST_GRACE_MS);
    await expectOpen(page, BLACK);

    // Unpin. The cursor is over the button again, so the hover preview
    // legitimately keeps it showing until the cursor leaves — then it must
    // close (it would stay open if it were still pinned).
    await page.locator(BLACK.btn).click();
    await moveToNeutral(page);
    await expectClosed(page, BLACK);
  });

  test('clicking a different info button closes the previously pinned one', async ({ page }) => {
    await page.locator(BLACK.btn).click();
    await expectOpen(page, BLACK);
    await page.locator(WHITE.btn).click();
    await expectOpen(page, WHITE);
    await expectClosed(page, BLACK);
  });

  test('clicking outside closes a pinned popover', async ({ page }) => {
    await page.locator(BLACK.btn).click();
    await expectOpen(page, BLACK);
    await page.locator('header').click({ position: { x: 5, y: 5 } });
    await expectClosed(page, BLACK);
  });

  test('clicking a control in another row closes a pinned popover', async ({ page }) => {
    // Clicking a different part of the sidebar (e.g. a slider in another
    // row) is "outside" as far as the pinned tip is concerned.
    await page.locator(BLACK.btn).click();
    await expectOpen(page, BLACK);
    await page.locator('#levels-white').click();
    await expectClosed(page, BLACK);
  });

  test('Escape closes a pinned popover', async ({ page }) => {
    await page.locator(BLACK.btn).click();
    await expectOpen(page, BLACK);
    await moveToNeutral(page);
    await page.keyboard.press('Escape');
    await expectClosedNow(page, BLACK);
  });

  test('Escape closes a hover-opened popover while still hovering', async ({ page }) => {
    await page.locator(BLACK.btn).hover();
    await expectOpen(page, BLACK);
    await page.keyboard.press('Escape');
    await expectClosedNow(page, BLACK);
  });
});

test.describe('info popovers — touch input', () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Precondition: the emulated device reports a coarse pointer, which is
    // what gates the hover layer off (isTouchPrimary in js/app.js). If this
    // ever stops being true the rest of the block would test nothing.
    expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expectClosedNow(page, BLACK);
  });

  test('tapping an info button pins it open; tapping again closes it', async ({ page }) => {
    await page.locator(BLACK.btn).tap();
    await expectOpen(page, BLACK);
    await page.waitForTimeout(PAST_GRACE_MS);
    await expectOpen(page, BLACK);

    await page.locator(BLACK.btn).tap();
    // No hover layer on touch, so the second tap closes it outright.
    await expectClosedNow(page, BLACK);
  });

  test('tapping a different info button closes the first', async ({ page }) => {
    await page.locator(BLACK.btn).tap();
    await expectOpen(page, BLACK);
    await page.locator(WHITE.btn).tap();
    await expectOpen(page, WHITE);
    await expectClosed(page, BLACK);
  });

  test('hover never opens a popover on a touch-primary device', async ({ page }) => {
    // A real mouse-move hover over the button...
    await page.locator(BLACK.btn).hover();
    await page.waitForTimeout(PAST_GRACE_MS);
    await expectClosedNow(page, BLACK);

    // ...and the synthetic mouseenter a coarse pointer can fire around a
    // tap. Neither may open anything.
    await page.locator(BLACK.btn).dispatchEvent('mouseenter');
    await page.locator(BLACK.pop).dispatchEvent('mouseenter');
    await page.waitForTimeout(PAST_GRACE_MS);
    await expectClosedNow(page, BLACK);
  });

  test('a tap-pinned popover is not closed by a synthetic mouseleave', async ({ page }) => {
    await page.locator(BLACK.btn).tap();
    await expectOpen(page, BLACK);
    await page.locator(BLACK.btn).dispatchEvent('mouseleave');
    await page.waitForTimeout(PAST_GRACE_MS);
    await expectOpen(page, BLACK);
  });
});

// Copy-drift guard: the path-simplify tip must describe what the slider
// actually does today (#24: real point reduction on straight-line runs,
// curves untouched, 0 = off), not the old decimal-precision-only behavior.
// Checked both ways: the words, and the behavior those words promise.
test.describe('info popover copy matches behavior', () => {
  // 32x32 blocky logo: traces to straight-line (L) runs only.
  const STRAIGHT_FIXTURE = path.resolve(__dirname, 'fixtures/test-logo.png');
  // Thin vertical strokes: traces to curve (C) segments only.
  const CURVED_FIXTURE = path.resolve(__dirname, 'fixtures/thin-strokes-small.png');

  // Number of coordinate values in the traced SVG's path data — a proxy for
  // point count that doesn't depend on absolute vs relative command form.
  async function tracePointCount(page: Page, value: string) {
    await page.locator('#path-simplify').fill(value);
    await page.locator('#trace-btn').click();
    await expect(page.locator('#status')).toHaveText('Done — SVG ready ✓', { timeout: 15000 });
    return page.locator('#preview-grid .on-light svg path').evaluateAll(paths => {
      const ds = paths.map(p => p.getAttribute('d') || '').join(' ');
      return {
        numbers: (ds.match(/-?\d*\.?\d+/g) || []).length,
        lines: (ds.match(/[Ll]/g) || []).length,
        curves: (ds.match(/[Cc]/g) || []).length,
      };
    });
  }

  async function load(page: Page, fixture: string) {
    await page.locator('#file-input').setInputFiles(fixture);
    await expect(page.locator('#trace-btn')).toBeEnabled({ timeout: 3000 });
  }

  test('path-simplify tip describes point reduction on straight runs, and the slider does that', async ({ page }) => {
    await page.goto('/');
    const copy = (await page.locator('#tip-path-simplify').textContent()) || '';
    expect(copy).toMatch(/reduces the number of points/i);
    expect(copy).toMatch(/straight/i);
    expect(copy).toMatch(/never touches curved/i);
    expect(copy).toMatch(/0 leaves every traced point untouched/i);
    // The pre-#24 behavior was a decimal-precision trim only.
    expect(copy).not.toMatch(/precision|decimal/i);

    // "Higher values remove more points" — on straight-line runs.
    await load(page, STRAIGHT_FIXTURE);
    const lineOff = await tracePointCount(page, '0');
    const lineMax = await tracePointCount(page, '24');
    expect(lineOff.lines).toBeGreaterThan(0);
    expect(lineMax.numbers).toBeLessThan(lineOff.numbers);

    // "never touches curved segments" — an all-curve trace keeps every point.
    await load(page, CURVED_FIXTURE);
    const curveOff = await tracePointCount(page, '0');
    const curveMax = await tracePointCount(page, '24');
    expect(curveOff.curves).toBeGreaterThan(0);
    expect(curveOff.lines).toBe(0);
    expect(curveMax.numbers).toBe(curveOff.numbers);
  });
});
