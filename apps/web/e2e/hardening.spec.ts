import { expect, test, type Page } from './fixtures.js';
import { totp } from '../../api/dist/common/crypto.js';
import { connectDb } from './db.js';
import {
  expectAccessible,
  login,
  previewSetup,
  openAccount,
  PM,
  pickOrganisation,
  resultsSection,
  shot,
  gotoTab,
} from './helpers.js';

const ADMIN = 'admin@demo.wansurvey.test';

async function openProject(page: Page) {
  await login(page, PM);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
}

/** Records Content-Security-Policy violations the page reports. */
async function watchCsp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}:${e.columnNumber} ${location.pathname}`,
      ),
    );
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

test('the app is served with a strict Content-Security-Policy and breaks none of it', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const violations = await watchCsp(page);
  const res = await page.goto('/login');
  const headers = res!.headers();
  expect(headers['content-security-policy']).toContain("script-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['permissions-policy']).toContain('geolocation=(self)');

  await openProject(page);
  await shot(page, 'project-home');
  for (const tab of ['Cases', 'Results', 'Exports', 'Project settings']) {
    await gotoTab(page, tab);
    await page.waitForLoadState('networkidle');
  }
  for (const section of ['Dashboard', 'Metrics'] as const) {
    await resultsSection(page, section);
    await page.waitForLoadState('networkidle');
  }
  await page.getByRole('tab', { name: 'Questionnaires' }).click();
  await page.getByRole('link', { name: 'Household questionnaire' }).click();
  await expect(page.getByRole('tree').first()).toBeVisible();
  await page.goto('/preview');
  await expect(page.locator('[data-qkey="A0_CONSENT_TEXT"]')).toBeVisible();
  expect(await violations()).toEqual([]);
});

test('a web respondent on a phone: keyboard only, 44 px targets, nothing sideways at 200% zoom', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('link', { name: 'Open the preview' }).click();
  await previewSetup(page);
  await page.getByTestId('mode').selectOption('CAWI');
  await previewSetup(page, false);
  const q = page.locator('[data-qkey]');
  await expect(q).toContainText('estamos realizando una encuesta');
  // Folding the set-up left the focus on its button: start from the question, as a
  // respondent's page does.
  await q.focus();

  // Every control a respondent touches is at least 44 × 44 CSS pixels (WCAG 2.5.5).
  const small = async () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="runner"] button, [data-testid="runner"] label:has(input), [data-testid="runner"] input:not([type=radio]):not([type=checkbox])',
        ),
      ]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({
          el: el.textContent?.trim().slice(0, 30) ?? el.tagName,
          r: el.getBoundingClientRect(),
        }))
        .filter(({ r }) => r.height < 44 || r.width < 44)
        .map(({ el, r }) => `${el} ${Math.round(r.width)}×${Math.round(r.height)}`),
    );
  expect(await small()).toEqual([]);

  // Keyboard only: Tab to the button and Enter; Space picks an option; type a number.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /Siguiente/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(q).toContainText('¿Acepta participar?');
  expect(await small()).toEqual([]);
  await page.keyboard.press('Space');
  await expect(page.getByRole('radio', { name: 'Sí' })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(q).toContainText('¿Cuántos años tiene?');
  await page.keyboard.type('40');
  await page.keyboard.press('Enter');
  await expect(q).toContainText('sexo');
  await expectAccessible(page);

  // 200% zoom on a 1280 px laptop is a 640 px wide layout: nothing scrolls sideways.
  await page.setViewportSize({ width: 640, height: 450 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
  await shot(page, 'respondent-zoom-200');
});

test('at 200% zoom the project pages reflow without scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 450 });
  await openProject(page);
  for (const tab of ['Cases', 'Dashboard', 'Results', 'Exports']) {
    if (tab === 'Dashboard') await resultsSection(page, 'Dashboard');
    // At 640 px the tabs that do not fit are under "More".
    else await gotoTab(page, tab);
    await page.waitForLoadState('networkidle');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      `${tab} scrolls sideways`,
    ).toBeLessThanOrEqual(640);
  }
});

test('at 200% zoom the administration pages reflow without scrolling sideways', async ({
  page,
}) => {
  // The administrator enrols a second factor on sign-in; the team test enrols it again, so its
  // two-step settings are put back as they were, before and after, whatever runs first.
  const db = connectDb();
  const reset2fa = () =>
    db.run(
      'UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE email = ?',
      [ADMIN],
    );
  try {
    await reset2fa();
    await page.setViewportSize({ width: 640, height: 450 });
    await login(page, ADMIN);
    await page.waitForURL(/\/login\/2fa\/setup/);
    const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
    await page.getByLabel('Code').fill(totp(secret));
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
    // Wide tables (Users, the matrix of Roles and permissions) scroll inside their own region,
    // not the page.
    for (const [path, title] of [
      ['/admin/audit', 'Activity log'],
      ['/admin/organisation', 'Organisation'],
      ['/admin/users', 'Users'],
      ['/admin/roles', 'Roles and permissions'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `${title} scrolls sideways`,
      ).toBeLessThanOrEqual(640);
      if (title === 'Users') await shot(page, 'p2-users-zoom-200', { fullPage: false });
      if (title === 'Roles and permissions')
        await shot(page, 'p2-roles-zoom-200', { fullPage: false });
    }
    await page.goto('/admin/organisation');
    await expect(page.getByRole('heading', { level: 1, name: 'Organisation' })).toBeVisible();
    // The section pills keep one line: those that do not fit are under "More", the open one shows.
    const sections = page.getByRole('navigation', { name: 'Administration sections' });
    await expect(sections.getByRole('link', { name: 'Organisation', exact: true })).toBeVisible();
    await expect(sections.getByRole('button', { name: 'More sections' })).toBeVisible();
    for (const box of await sections
      .locator('a, button')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right)))
      expect(box).toBeLessThanOrEqual(640);
    await shot(page, 'v2-admin-zoom-200-organisation', { fullPage: false });
    await sections.getByRole('button', { name: 'More sections' }).click();
    await page.getByRole('menuitem', { name: 'Activity log' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Activity log' })).toBeVisible();
    await expect(sections.getByRole('link', { name: 'Activity log', exact: true })).toBeVisible();
  } finally {
    await reset2fa();
    await db.end();
  }
});

test("a data subject's personal data is downloaded and erased from the case", async ({ page }) => {
  await openProject(page);
  await page.getByRole('tab', { name: 'Cases' }).click();
  await page.getByLabel('Search id or sample data').fill('HH0049');
  const row = page.locator('tr[data-case="HH0049"]');
  await row.getByRole('button', { name: 'Open case HH0049' }).click();
  const drawer = page.getByRole('dialog', { name: 'Case HH0049' });
  // Sealed personal fields come back on reveal.
  await drawer.getByRole('button', { name: 'Show personal data' }).click();
  await expect(drawer.getByText('first_name')).toBeVisible();
  const section = drawer.getByTestId('personal-data');
  const download = page.waitForEvent('download');
  await section.getByRole('button', { name: 'Download what is held (JSON)' }).click();
  expect((await download).suggestedFilename()).toBe('datos-HH0049.json');
  await section.getByRole('button', { name: 'Erase personal data…' }).click();
  await section.getByLabel('Request reference (kept in the audit log)').fill('ARCO-2026-001');
  await section.getByRole('button', { name: 'Erase', exact: true }).click();
  await expect(section.getByRole('status')).toHaveText('Personal data erased.');
  await expect(section).toContainText('Personal data removed on');
  await expect(drawer).toContainText('Personal data removed');
  await shot(page, 'case-personal-data');
  await expectAccessible(page);
});

test('the dark theme: chosen in the account menu, remembered, and readable on every main page', async ({
  page,
}) => {
  await openProject(page);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await openAccount(page);
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  // Every main page passes the accessibility checks (colour contrast included) in the dark.
  const tabs = ['Questionnaires', 'Cases', 'Results', 'Project settings'];
  for (const tab of tabs) {
    await gotoTab(page, tab);
    await expect(page.getByRole('tabpanel').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectAccessible(page);
  }
  await resultsSection(page, 'Dashboard');
  await shot(page, 'dark-dashboard', { fullPage: false });
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();
  await page.getByRole('link', { name: 'Household questionnaire' }).click();
  await expect(page.getByRole('tree', { name: 'Outline' })).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'dark-designer', { fullPage: false });
  // Remembered on this device, and applied before the page paints.
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.goto('/preview');
  await expect(page.locator('[data-qkey]').first()).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'dark-preview', { fullPage: false });
});

test('the theme follows the device until one is chosen', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // The page loads lazily: check it once it is there.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'dark-login', { fullPage: false });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
