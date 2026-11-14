import { expect, overlaysSettled, test } from './fixtures.js';
import { totp } from '../../api/dist/common/crypto.js';
import { login } from './helpers.js';

/**
 * Dialogs that no other flow opens. Each one is checked with axe while it is open (the fixture
 * does it; `overlaysSettled` waits for it), then closed with Escape, which must return the focus
 * to the control that opened it.
 */
// The owner is used by no other test: enrolling its second factor here disturbs none.
const OWNER = 'owner@demo.wansurvey.test';

async function closesWithEscape(
  page: import('@playwright/test').Page,
  dialog: import('@playwright/test').Locator,
  opener: import('@playwright/test').Locator,
) {
  await expect(dialog).toBeVisible();
  // The focus is inside the dialog.
  await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
}

test('the API keys and webhooks dialogs are accessible and return the focus', async ({ page }) => {
  await login(page, OWNER);
  await page.waitForURL(/\/login\/2fa\/setup/);
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  await page.getByLabel('Code').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  await page.goto('/admin/api-keys');
  const key = page.getByRole('button', { name: 'New key' });
  await key.click();
  await overlaysSettled(page, 1);
  await closesWithEscape(page, page.getByRole('dialog', { name: 'New key' }), key);

  // Making one shows the key once, in a dialog of its own.
  await key.click();
  await overlaysSettled(page, 2);
  const form = page.getByRole('dialog', { name: 'New key' });
  await form.getByLabel('Name', { exact: true }).fill('Power BI');
  await form.getByRole('button', { name: 'Create the key' }).click();
  await expect(page.getByText('Copy the key now: it is shown only once.')).toBeVisible();
  await overlaysSettled(page, 3);
  await page.getByRole('button', { name: 'Done' }).click();

  await page.goto('/admin/webhooks');
  const hook = page.getByRole('button', { name: 'New webhook' });
  await hook.click();
  await overlaysSettled(page, 1);
  await closesWithEscape(page, page.getByRole('dialog', { name: 'New webhook' }), hook);

  // Making one shows the signing secret once; the deliveries have a dialog too.
  await hook.click();
  await overlaysSettled(page, 2);
  const made = page.getByRole('dialog', { name: 'New webhook' });
  await made.getByLabel('Address (https)').fill('https://example.org/hook');
  await made.getByRole('checkbox').first().check();
  await made.getByRole('button', { name: 'Create the webhook' }).click();
  await expect(page.getByRole('dialog', { name: 'Signing secret' })).toBeVisible();
  await overlaysSettled(page, 3);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Deliveries' }).first().click();
  await overlaysSettled(page, 4);
  await expect(page.getByRole('dialog', { name: 'Deliveries' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('withdrawing cases in bulk: the dialog is accessible and returns the focus', async ({
  page,
}) => {
  await login(page);
  await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await page.getByRole('tab', { name: 'Cases' }).click();
  await page
    .getByRole('checkbox', { name: /^Select case/ })
    .first()
    .check();
  const open = page.getByRole('button', { name: 'Withdraw selected' });
  await open.click();
  await overlaysSettled(page, 1);
  await closesWithEscape(page, page.getByRole('dialog', { name: /^Withdraw \d+ cases?/ }), open);
});

test('the logic check of the designer opens as a dialog, accessible, and closes with Escape', async ({
  page,
}) => {
  await login(page);
  await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();
  await page.getByRole('link', { name: 'Household questionnaire' }).click();
  await expect(page.getByRole('tree', { name: 'Outline' })).toBeVisible();
  await page.getByRole('tab', { name: 'Routing' }).click();
  const check = page.getByRole('button', { name: 'Check the logic' });
  await check.click();
  const popover = page.getByTestId('logic-check');
  await overlaysSettled(page, 1);
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
});
