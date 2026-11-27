import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'demo-password-123';
export const PM = 'project.manager@demo.wansurvey.test';

export async function login(page: Page, email = PM) {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Opens the account menu (the badge at the top right) if it is closed. */
export async function openAccount(page: Page) {
  const badge = page.getByRole('button', { name: /^Account:/ });
  if ((await badge.getAttribute('aria-expanded')) !== 'true') await badge.click();
}

/** Switches to an organisation from the account menu (if not already in it) and closes the menu. */
export async function pickOrganisation(page: Page, name: string) {
  await openAccount(page);
  const org = page.getByRole('combobox', { name: 'Organisation' });
  await expect(org).toBeVisible();
  if ((await org.locator('option:checked').textContent()) !== name) {
    await org.selectOption({ label: name });
    await expect(org.locator('option:checked')).toHaveText(name);
  }
  await org.focus();
  await page.keyboard.press('Escape');
  await expect(org).toBeHidden();
}

const require = createRequire(import.meta.url);

const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** axe-core in the real browser, including colour contrast. */
export async function expectAccessible(page: Page, include?: string) {
  // Evaluated through DevTools, which the page's Content-Security-Policy does not apply to
  // (a script tag would be refused, as it should be).
  await page.evaluate(axeSource);
  const violations = await page.evaluate(async (sel) => {
    const axe = (
      window as unknown as {
        axe: {
          run(
            ctx: unknown,
            opts: unknown,
          ): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      }
    ).axe;
    const r = await axe.run(sel ? { include: [sel] } : document, { resultTypes: ['violations'] });
    return r.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    );
  }, include ?? null);
  expect(violations).toEqual([]);
}

/**
 * A full-page screenshot when SCREENSHOTS is set. Pictures are always of the Spanish
 * interface: the language is switched for the picture only, then put back.
 */
export async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
  if (!process.env.SCREENSHOTS) return;
  const html = page.locator('html');
  const before = (await html.getAttribute('lang')) ?? 'es';
  const setLang = (lng: string) =>
    page.evaluate((l) => window.dispatchEvent(new CustomEvent('ws:lang', { detail: l })), lng);
  if (before !== 'es') {
    await setLang('es');
    await expect(html).toHaveAttribute('lang', 'es');
    await page.waitForTimeout(150);
  }
  await page.screenshot({
    path: `${process.env.SCREENSHOTS}/${name}.png`,
    fullPage: opts.fullPage ?? true,
  });
  if (before !== 'es') {
    await setLang(before);
    await expect(html).toHaveAttribute('lang', before);
    await page.waitForTimeout(150);
  }
}

/** Opens a questionnaire's action (web survey, paper forms) from the Questionnaires tab. */
export async function questionnaireAction(
  page: Page,
  action: 'Web survey' | 'Paper forms',
  name = 'Household questionnaire',
) {
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

/** Opens a clerk's or interviewer's paper forms: their own tab, without the questionnaires. */
export async function paperTab(page: Page) {
  await page
    .getByRole('tablist', { name: 'Project sections' })
    .getByRole('tab', { name: 'Paper forms', exact: true })
    .click();
}

/**
 * Opens the summary (Results tab), the live dashboard (the project's Overview) or the metrics
 * (in Supervision beside the review queue, or a tab of their own).
 */
export async function resultsSection(page: Page, section: 'Summary' | 'Dashboard' | 'Metrics') {
  const tabs = page.getByRole('tablist', { name: 'Project sections' });
  if (section === 'Summary') return tabs.getByRole('tab', { name: 'Results', exact: true }).click();
  if (section === 'Dashboard')
    return tabs.getByRole('tab', { name: 'Overview', exact: true }).click();
  const supervision = tabs.getByRole('tab', { name: 'Supervision', exact: true });
  if (await supervision.count()) {
    await supervision.click();
    await page
      .getByRole('tablist', { name: 'Supervision sections' })
      .getByRole('tab', { name: 'Metrics', exact: true })
      .click();
  } else await tabs.getByRole('tab', { name: 'Metrics', exact: true }).click();
}
