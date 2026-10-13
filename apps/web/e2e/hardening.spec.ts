import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, login, PM, shot, pickOrganisation } from './helpers.js';

async function openProject(page: Page) {
  await login(page, PM);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByRole('link', { name: 'Household Survey 2026' }).click();
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
  for (const tab of ['Cases', 'Dashboard', 'Metrics', 'Results', 'Exports', 'Settings']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForLoadState('networkidle');
  }
  await page.getByRole('tab', { name: 'Questionnaires' }).click();
  await page.getByRole('link', { name: 'Household questionnaire' }).click();
  await expect(page.getByRole('tree').first()).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Questionnaire preview' })
    .click();
  await expect(page.locator('[data-qkey="A0_CONSENT_TEXT"]')).toBeVisible();
  expect(await violations()).toEqual([]);
});

test('a web respondent on a phone: keyboard only, 44 px targets, nothing sideways at 200% zoom', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('link', { name: 'Questionnaire preview' }).click();
  await page.getByTestId('mode').selectOption('CAWI');
  const q = page.locator('[data-qkey]');
  await expect(q).toContainText('estamos realizando una encuesta');

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
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForLoadState('networkidle');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      `${tab} scrolls sideways`,
    ).toBeLessThanOrEqual(640);
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
