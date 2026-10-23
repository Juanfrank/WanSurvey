import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, login } from './helpers.js';

/**
 * Every question type, as respondents see it, passes axe (contrast included) before and after
 * it is answered and with its error shown, and reflows at 320 px without sideways scrolling.
 */
async function openAllTypes(page: Page, mode: 'CAWI' | 'CAPI') {
  await login(page);
  await page.getByRole('link', { name: 'Open the preview' }).click();
  await expect(page.getByRole('heading', { name: 'Questionnaire preview' })).toBeVisible();
  await page
    .locator('select', { has: page.locator('option[value="all-types"]') })
    .selectOption('all-types');
  await page.getByTestId('mode').selectOption(mode);
  await expect(page.locator('[data-qkey]').first()).toBeVisible();
}

/** Answers what the page shows: first option, a mid scale point, a moved rank, some text. */
async function answerPage(page: Page) {
  for (const q of await page.locator('[data-qkey]').all()) {
    const radios = q.locator('input[type=radio]');
    const groups = new Set<string>();
    for (const r of await radios.all()) {
      const name = (await r.getAttribute('name')) ?? '';
      if (groups.has(name)) continue;
      groups.add(name);
      // A second click on the chosen option clears it: leave answered groups alone.
      if (await q.locator(`input[type=radio][name="${name}"]:checked`).count()) continue;
      await r.check({ force: true });
    }
    // The first option of a multiple choice (not a warning's confirmation box).
    const box = q.locator('[data-qbody] input[type=checkbox]').first();
    if ((await box.count()) && !(await box.isChecked())) await box.click();
    const down = q.locator('[data-move="down"]').first();
    if (await down.count()) {
      await down.click();
      await expect(q.getByTestId('rank-announce')).not.toBeEmpty();
    }
    // A searchable dropdown: open it and take the first option.
    for (const combo of await q.getByRole('combobox').all()) {
      await combo.focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
    }
    for (const input of await q
      .locator(
        'input:not([type=radio]):not([type=checkbox]):not([type=range]):not([type=search]):not([role=combobox]), textarea',
      )
      .all()) {
      if (!(await input.isEditable()) || (await input.inputValue())) continue;
      const type = await input.getAttribute('type');
      const mode = await input.getAttribute('inputmode');
      await input.fill(
        type === 'date'
          ? '2026-01-15'
          : type === 'time'
            ? '10:30'
            : type === 'datetime-local'
              ? '2026-01-15T10:30'
              : type === 'email'
                ? 'ana@example.org'
                : mode === 'numeric' || mode === 'decimal' || type === 'tel'
                  ? '3'
                  : 'Texto',
      );
    }
  }
}

for (const width of [1280, 320]) {
  test(`every question type is accessible as a respondent sees it (${width} px)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await openAllTypes(page, 'CAWI');
    const next = page.getByRole('button', { name: /Siguiente/ });
    for (let n = 0; n < 40 && (await next.count()); n++) {
      await expectAccessible(page);
      if (width === 320)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          320,
        );
      // Moving on without answering shows the errors: still accessible, fields marked invalid.
      const before = await page.locator('[data-qkey]').first().getAttribute('data-qkey');
      await next.click();
      const after = await page.locator('[data-qkey]').first().getAttribute('data-qkey');
      if (after === before && (await page.locator('[data-rule]').count())) {
        await expectAccessible(page);
        await answerPage(page);
        await expectAccessible(page);
        await next.click();
      }
    }
  });
}

test('an interviewer’s screen of every question type is accessible', async ({ page }) => {
  test.setTimeout(120_000);
  await openAllTypes(page, 'CAPI');
  const next = page.getByRole('button', { name: /Next|Siguiente/ });
  for (let n = 0; n < 40 && (await next.count()) && (await next.isEnabled()); n++) {
    await answerPage(page);
    await expectAccessible(page);
    await next.click();
  }
});
