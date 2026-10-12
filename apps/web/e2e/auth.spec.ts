import { expect, test } from '@playwright/test';
import { expectAccessible, login, PM, shot } from './helpers.js';

test('sign in, switch organisation, sign out', async ({ page }) => {
  await page.goto('/login');
  await expectAccessible(page);
  await shot(page, 'login');
  await login(page);
  await expect(page.getByRole('heading', { name: /Welcome, project_manager/ })).toBeVisible();
  await expect(page.getByText('Household Survey 2026')).toBeVisible();
  await page.getByLabel('Organisation').selectOption({ label: 'Second Agency' });
  await expect(page.getByText('Business Panel')).toBeVisible();
  await expect(page.getByText('Household Survey 2026')).toHaveCount(0);
  await page.getByLabel('Language').selectOption('es');
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('wrong password shows a clear error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(PM);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('The e-mail or password is not correct.');
});

test('someone without a role lands on the waiting page', async ({ page }) => {
  await login(page, 'waiting@demo.wansurvey.test');
  await expect(page).toHaveURL(/\/waiting$/);
  await expect(page.getByTestId('access-message')).toContainText(
    'no role has been assigned to you in Demo Research yet',
  );
  await expectAccessible(page);
  await shot(page, 'waiting');
});

test('Microsoft sign-in goes through the API and explains when it is not set up', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill('ana@agency.example');
  const started = page.waitForRequest((r) =>
    r.url().includes('/api/v1/auth/sso/start?email=ana%40agency.example'),
  );
  await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
  await started;
  await expect(page).toHaveURL(/\/login\?sso_error=sso_not_configured/);
  await expect(page.getByRole('alert')).toHaveText(
    'Microsoft sign-in is not set up for your organisation.',
  );
});
