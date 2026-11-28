import { expect, test } from './fixtures.js';
import { expectAccessible, login, openAccount, pickOrganisation, PM, shot } from './helpers.js';

test('sign in, switch organisation, sign out', async ({ page }) => {
  await page.goto('/login');
  // axe needs the rendered page, not the empty shell.
  await expect(page.getByRole('main')).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'login');
  await login(page);
  await expect(page.getByRole('heading', { name: /Welcome, project_manager/ })).toBeVisible();
  await expect(page.getByRole('main').getByText('Household Survey 2026')).toBeVisible();
  await pickOrganisation(page, 'Second Agency');
  await expect(page.getByRole('main').getByText('Business Panel')).toBeVisible();
  await expect(page.getByRole('main').getByText('Household Survey 2026')).toHaveCount(0);
  // Back to the first organisation: the next sign-in opens the last one used.
  await pickOrganisation(page, 'Demo Research');
  await openAccount(page);
  await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('the side panel compacts to a rail of icons, opens over the page on hover, and is remembered', async ({
  page,
}) => {
  await login(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  const panel = page.locator('header').first();
  const wide = (await panel.boundingBox())!.width;
  expect(wide).toBeGreaterThan(280);
  await openAccount(page);
  await shot(page, 'account-menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Compact the side panel' }).click();
  await page.mouse.move(800, 400);
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeLessThan(80);
  // The links keep their names for screen readers.
  await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
  await shot(page, 'side-panel-compact');
  await expectAccessible(page);
  await page.reload();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeLessThan(80);
  // Pointing at the rail opens the panel over the page, which moves the button: wait for it
  // to settle before pressing, as a person does, then leave and check that it stayed open.
  const inner = panel.locator('> div').first();
  await panel.hover();
  await expect.poll(async () => (await inner.boundingBox())!.width).toBeGreaterThan(280);
  await page.getByRole('button', { name: 'Keep the side panel open' }).click();
  await page.mouse.move(800, 400);
  await expect(page.getByRole('button', { name: 'Compact the side panel' })).toBeVisible();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(280);
});

test('home shows a project manager the projects with their fieldwork', async ({ page }) => {
  await login(page);
  await pickOrganisation(page, 'Demo Research');
  await expect(page.getByRole('heading', { name: /Welcome, project_manager/ })).toBeVisible();
  const table = page.getByTestId('home-portfolio');
  await expect(table.getByRole('columnheader', { name: 'Unassigned' })).toBeVisible();
  await expect(table.getByRole('row', { name: /Household Survey 2026/ })).toBeVisible();
  // Each project's fieldwork dates and its last interview activity.
  await expect(table.getByRole('columnheader', { name: 'Fieldwork' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Last activity' })).toBeVisible();
  await expect(
    table.getByRole('row', { name: /Household Survey 2026/ }).getByTestId('home-last-activity'),
  ).not.toHaveText('None yet');
  // The preview stays a secondary link for those who design questionnaires.
  await expect(page.getByRole('link', { name: 'Open the preview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My day' })).toHaveCount(0);
  await expectAccessible(page);
  await shot(page, 'home-project-manager');
  await shot(page, 'v2-home-portfolio');
});

test('home shows an interviewer their day and not the preview', async ({ page }) => {
  await login(page, 'interviewer@demo.wansurvey.test');
  await expect(page.getByRole('heading', { name: /Welcome, interviewer/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My day' })).toBeVisible();
  await expect(page.getByText('Cases to do', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'For today' })).toBeVisible();
  const project = page.getByTestId('home-day-project').filter({ hasText: 'Household Survey 2026' });
  await expect(project.getByRole('link', { name: 'My cases' })).toBeVisible();
  await expect(page.getByTestId('home-portfolio')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open the preview' })).toHaveCount(0);
  await expectAccessible(page);
  await shot(page, 'home-interviewer');
  await project.getByRole('link', { name: 'My cases' }).click();
  await expect(page).toHaveURL(/tab=cases/);
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

test.describe('a first visit', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('shows the interface in Spanish', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
    await expect(page.getByLabel('Correo electrónico')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('es');
    await shot(page, 'login-es');
    await expectAccessible(page);
  });
});
