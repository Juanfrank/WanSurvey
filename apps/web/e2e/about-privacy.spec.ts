import { expect, test } from '@playwright/test';
import { expectAccessible, shot } from './helpers.js';

test('About and Privacy are public, reachable from the sign-in page, and accessible', async ({
  page,
}) => {
  await page.goto('/login');
  await page
    .getByRole('navigation', { name: 'About' })
    .getByRole('link', { name: 'About' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'About WanSurvey' })).toBeVisible();
  await expect(page.getByText(/Version \d+\.\d+\.\d+/)).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'about', { fullPage: true });

  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy Policy' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
  for (const h of ['Who answers for your data', 'Your rights', 'How long it is kept'])
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(h) })).toBeVisible();
  // This installation has the address service on, so the policy names it (and says nothing of
  // Microsoft or SMS, which are off).
  await expect(page.getByText(/OpenStreetMap/)).toHaveCount(1);
  await expect(page.getByText(/SMS provider|Microsoft/)).toHaveCount(0);
  await expectAccessible(page);
  await shot(page, 'privacy', { fullPage: true });
});
