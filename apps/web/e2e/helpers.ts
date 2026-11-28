import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Locator, type Page } from '@playwright/test';

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

/**
 * Opens a project's tab by its name (English or Spanish), wherever it is: in the row of tabs or
 * under "More ▾", where People, the project settings and the tabs that do not fit are kept.
 */
export async function gotoTab(page: Page, name: string) {
  const tabs = page.getByRole('tablist', { name: /^(Project sections|Secciones del proyecto)$/ });
  await expect(tabs.getByRole('tab').first()).toBeVisible();
  const tab = tabs.getByRole('tab', { name, exact: true });
  if (!(await tab.count())) {
    await page.getByRole('button', { name: /^(More sections|Más secciones)$/ }).click();
    await page
      .getByRole('menu', { name: /^(More sections|Más secciones)$/ })
      .getByRole('menuitem', { name, exact: true })
      .click();
  } else await tab.click();
  await expect(tabs.getByRole('tab', { name, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

/**
 * Opens a topic of the questionnaire designer (Form, Routing, Preview… under Design; General,
 * Quotas… under Settings) by its name, wherever it is: in the row beside Design / Settings or,
 * when the row is narrow, under its "More ▾". A count after the name (Routing 2) is allowed.
 */
export async function designerTab(page: Page, name: string) {
  const tabs = page.getByRole('tablist', {
    name: /^(Design sections|Settings topics|Secciones del diseño|Temas de los ajustes)$/,
  });
  await expect(tabs.getByRole('tab').first()).toBeVisible();
  const named = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\d*$`);
  const tab = tabs.getByRole('tab', { name: named });
  if (!(await tab.count())) {
    const row = page.getByTestId('designer-tabs-row');
    await row.getByRole('button', { name: /^(More sections|Más secciones)$/ }).click();
    await page
      .getByRole('menu', { name: /^(More sections|Más secciones)$/ })
      .getByRole('menuitem', { name, exact: true })
      .click();
  } else await tab.click();
  await expect(tabs.getByRole('tab', { name: named })).toHaveAttribute('aria-selected', 'true');
}

/**
 * Opens a list's Filters panel (FilterBar: the selects and quick filters are behind the
 * "Filters" button), if it is closed. `scope`: where the list is, when the page has several.
 */
export async function openFilters(page: Page, scope?: Locator) {
  const button = (scope ?? page).getByRole('button', { name: /^(Filters|Filtros)( · \d+)?$/ });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
}

/** Closes the Filters panel (Escape, from inside it) if it is open. */
export async function closeFilters(page: Page, scope?: Locator) {
  const button = (scope ?? page).getByRole('button', { name: /^(Filters|Filtros)( · \d+)?$/ });
  if ((await button.getAttribute('aria-expanded')) === 'true') await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
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

/** The element shows all of its text: not cut short with "…" (nor overflowing its box). */
export async function expectWhole(target: Locator) {
  await expect.poll(() => target.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
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

/**
 * A screenshot of something that floats at a fixed place (an open "⋯" menu): `open` opens it
 * once the interface is in Spanish, so the text switch does not move the rows from under it;
 * Escape closes it after the picture. Without SCREENSHOTS nothing is done.
 */
export async function shotOpen(
  page: Page,
  name: string,
  open: () => Promise<void>,
  opts: { fullPage?: boolean } = {},
) {
  if (!process.env.SCREENSHOTS) return;
  const html = page.locator('html');
  const before = (await html.getAttribute('lang')) ?? 'es';
  const setLang = async (lng: string) => {
    await page.evaluate(
      (l) => window.dispatchEvent(new CustomEvent('ws:lang', { detail: l })),
      lng,
    );
    await expect(html).toHaveAttribute('lang', lng);
    await page.waitForTimeout(150);
  };
  if (before !== 'es') await setLang('es');
  await open();
  await shot(page, name, opts);
  await page.keyboard.press('Escape');
  if (before !== 'es') await setLang(before);
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
  if (section === 'Summary') return gotoTab(page, 'Results');
  if (section === 'Dashboard') return gotoTab(page, 'Overview');
  // Supervision, when there is one, holds the metrics beside the review queue.
  await expect(tabs.getByRole('tab').first()).toBeVisible();
  const more = page.getByRole('button', { name: 'More sections' });
  let supervision = (await tabs.getByRole('tab', { name: 'Supervision', exact: true }).count()) > 0;
  if (!supervision && (await more.count())) {
    await more.click();
    supervision =
      (await page.getByRole('menuitem', { name: 'Supervision', exact: true }).count()) > 0;
    await page.keyboard.press('Escape');
  }
  if (supervision) {
    await gotoTab(page, 'Supervision');
    await page
      .getByRole('tablist', { name: 'Supervision sections' })
      .getByRole('tab', { name: 'Metrics', exact: true })
      .click();
  } else await gotoTab(page, 'Metrics');
}

/** Picks one of the selected item's actions behind "⋯" in the designer's editor header. */
export async function itemAction(page: Page, id: string, action: string | RegExp) {
  await page.getByRole('button', { name: `More actions for ${id}` }).click();
  await page
    .getByRole('menu', { name: `More actions for ${id}` })
    .getByRole('menuitem', { name: action })
    .click();
}

/**
 * Opens (or folds back) the preview's test set-up (questionnaire, mode, language…): below
 * 768 px it is folded behind "Set up the test"; wider, it is always open and this does nothing.
 */
export async function previewSetup(page: Page, open = true) {
  const fold = page.getByRole('button', { name: /^Set up the test/ });
  // The set-up is there once the questionnaire runs: the fold, or the open mode picker.
  await expect(fold.or(page.getByTestId('mode')).first()).toBeVisible();
  if (!(await fold.count())) return;
  if ((await fold.getAttribute('aria-expanded')) !== String(open)) await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', String(open));
}
