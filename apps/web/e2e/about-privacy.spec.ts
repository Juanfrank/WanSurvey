import { expect, test } from '@playwright/test';
import { expectAccessible, login, shot } from './helpers.js';

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

  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible();
  for (const h of ['Who answers for your data', 'What your rights are', 'How long it is kept'])
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(h) })).toBeVisible();
  // This installation has the address service on, so the policy names it (and says nothing of
  // Microsoft or SMS, which are off).
  await expect(page.getByText(/OpenStreetMap/)).toHaveCount(1);
  await expect(page.getByText(/SMS provider|Microsoft/)).toHaveCount(0);
  await expectAccessible(page);
  await shot(page, 'privacy', { fullPage: true });
});

test('About follows the common structure: public without build data, keyboard, back, language', async ({
  page,
}) => {
  await page.goto('/about');
  await expect(page.getByRole('heading', { level: 1, name: 'About WanSurvey' })).toBeVisible();
  const h2 = await page.getByRole('heading', { level: 2 }).allTextContents();
  // What, who, version, rights (the author is fixed), access, contact, documents (no
  // technical section without a session).
  expect(h2).toEqual([
    'What it is',
    'Who runs it',
    'Version',
    'Authorship and ownership',
    'How to access it',
    'Contact',
    'Documents',
  ]);
  // The author is fixed in the project and shown without any setting.
  await expect(page.locator('#rights')).toContainText('Author: Juan Francisco Medina.');
  await expect(page.getByRole('heading', { name: 'Technical details' })).toHaveCount(0);
  await expect(page.getByLabel('Language')).toBeVisible();
  // The internal documents are links of the application.
  await expect(
    page.locator('#documents').getByRole('link', { name: 'Privacy policy' }),
  ).toHaveAttribute('href', '/privacy');
  // Keyboard: the contents link moves to its section.
  await page
    .getByRole('navigation', { name: 'About WanSurvey' })
    .getByRole('link', { name: 'Version' })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#version$/);
  // Back goes where the person came from.
  await page.goto('/login');
  await page
    .getByRole('navigation', { name: 'About' })
    .getByRole('link', { name: 'About' })
    .click();
  await page
    .getByRole('contentinfo')
    .getByRole('link', { name: 'Back to the application' })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectAccessible(page);
});

test('With a session, About is inside the application and adds the technical details', async ({
  page,
}) => {
  await login(page);
  await page.waitForURL('**/');
  await page.goto('/about');
  await expect(page.getByRole('heading', { level: 1, name: 'About WanSurvey' })).toBeVisible();
  // Inside the frame: the application's menu is there.
  await expect(page.getByRole('link', { name: 'Home' }).first()).toBeVisible();
  const last = page.getByRole('heading', { level: 2 }).last();
  await expect(last).toHaveText('Technical details');
  await expect(page.locator('#technical')).toContainText(/Build: .+/);
  await expect(page.locator('#technical')).toContainText(/Node: \d+/);
  await expectAccessible(page);
});
