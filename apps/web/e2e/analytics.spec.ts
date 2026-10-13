import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, login, PM, shot, pickOrganisation } from './helpers.js';

const INTERVIEWER = 'interviewer@demo.wansurvey.test';
const SUPERVISOR = 'supervisor@demo.wansurvey.test';

async function openProject(page: Page, email: string) {
  await login(page, email);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByRole('link', { name: 'Household Survey 2026' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
}

const question = (page: Page, id: string) => page.locator(`[data-qkey^="${id}"]`).first();
async function onQuestion(page: Page, id: string) {
  const q = question(page, id);
  await expect(q).toBeVisible();
  await expect
    .poll(() =>
      q.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)),
    )
    .toBe(true);
}

/** The count in one row of a dashboard bar table. */
const barValue = async (page: Page, label: string) =>
  Number(
    await page
      .getByTestId('dashboard')
      .locator('tr', { has: page.getByRole('rowheader', { name: label, exact: true }) })
      .first()
      .locator('td span.tabular-nums')
      .textContent(),
  );

test('the supervisor dashboard updates live when an interview is submitted elsewhere', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const sup = await (await browser.newContext({ storageState: './e2e/english-ui.json' })).newPage();
  await openProject(sup, SUPERVISOR);
  await sup.getByRole('tab', { name: 'Dashboard' }).click();
  await expect(sup.getByTestId('live-status')).toHaveText('Live');
  await expect(sup.getByTestId('completes')).toHaveText('60');
  const finalised = await barValue(sup, 'Finalised');

  // In another browser, the interviewer screens out a respondent (aged 15) and submits.
  const iv = await (await browser.newContext({ storageState: './e2e/english-ui.json' })).newPage();
  await openProject(iv, INTERVIEWER);
  await iv.getByRole('tab', { name: 'My cases' }).click();
  await iv.getByRole('combobox', { name: /^Status/ }).selectOption('assigned');
  const row = iv.getByTestId('cases-table').locator('tbody tr').first();
  await expect(row).toContainText('Assigned');
  const caseId = (await row.getAttribute('data-case'))!;
  await row.getByRole('button', { name: `Open case ${caseId}` }).click();
  const drawer = iv.getByRole('dialog', { name: `Case ${caseId}` });
  await drawer.getByRole('button', { name: 'Start interview' }).click();
  await drawer.getByLabel('Mode').selectOption('CAPI');
  await drawer.getByRole('button', { name: 'Start interview' }).click();
  await onQuestion(iv, 'A0_CONSENT_TEXT');
  await iv.keyboard.press('Enter');
  await onQuestion(iv, 'A1');
  await iv.keyboard.type('1');
  await iv.keyboard.press('Enter');
  await onQuestion(iv, 'A2');
  await iv.keyboard.type('15');
  await iv.keyboard.press('Enter');
  await expect(iv.getByTestId('save-status')).toHaveAttribute('data-status', 'saved', {
    timeout: 10_000,
  });
  // The first submission of the run, on freshly started servers: wait for the server's answer
  // (and show it if it is not a success) before the page goes back to the project.
  const submitted = iv.waitForResponse((r) => /\/interviews\/[^/]+\/submit$/.test(r.url()));
  await iv.getByRole('button', { name: 'Submit interview' }).click();
  const res = await submitted;
  expect(res.status(), await res.text()).toBe(200);
  await expect(iv.getByRole('tablist', { name: 'Project sections' })).toBeVisible({
    timeout: 15_000,
  });

  // Without reloading, the dashboard shows the finished case and who is working.
  await expect.poll(() => barValue(sup, 'Finalised'), { timeout: 15_000 }).toBe(finalised + 1);
  await expect(sup.getByTestId('active')).toContainText('Demo interviewer');
  await shot(sup, 'live-dashboard');
  await expectAccessible(sup);
});

test('team metrics, topline, crosstab, summary and a client link', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await openProject(page, PM);
  await page.getByRole('tab', { name: 'Metrics' }).click();
  const rows = page.getByTestId('metrics-row');
  await expect(rows).toHaveCount(5);
  // The quick interviewer stands out on interview length.
  await expect(
    rows.filter({ hasText: 'Carlos Huamán' }).locator('td[data-outlier="-1"]').first(),
  ).toBeVisible();
  await shot(page, 'team-metrics');
  await expectAccessible(page);

  await page.getByRole('tab', { name: 'Results' }).click();
  await expect(page.getByTestId('n')).toHaveText('60 complete interviews');
  const sex = page.getByTestId('topline').locator('[data-variable="A3_SEX"]');
  await expect(sex).toContainText('Base: 60');
  await page.getByLabel('Rows').selectOption('A3_SEX');
  await page.getByLabel('Columns').selectOption('A4_MARITAL');
  await expect(page.getByTestId('crosstab')).toContainText('Total');
  await page.getByLabel('Mode').first().selectOption('CATI');
  await expect(page.getByTestId('n')).toHaveText('17 complete interviews');
  await page.getByLabel('Mode').first().selectOption('');
  await shot(page, 'topline-crosstab');
  await expectAccessible(page);

  // A link for the client: a read-only summary without signing in.
  await page.getByRole('button', { name: 'Create a link' }).click();
  const url = await page.getByTestId('share-links').getByLabel('URL').first().inputValue();
  const client = await (
    await browser.newContext({ storageState: './e2e/english-ui.json' })
  ).newPage();
  await client.goto(new URL(url).pathname);
  await expect(client.getByTestId('summary')).toContainText('Summary · Household Survey 2026');
  await expect(client.getByTestId('summary')).toContainText('Read-only summary shared with you.');
  await expect(client.getByTestId('topline').locator('[data-variable="A3_SEX"]')).toBeVisible();
  await shot(client, 'summary');
  await expectAccessible(client);
  await page.getByTestId('share-links').getByRole('button', { name: 'Revoke' }).first().click();
  await client.reload();
  await expect(client.getByRole('alert')).toHaveText('This link is not valid or has expired.');
});

test('exports are built by the worker and download with the expected header', async ({ page }) => {
  test.setTimeout(120_000);
  await openProject(page, PM);
  await page.getByRole('tab', { name: 'Exports' }).click();
  await page.getByLabel('Format').selectOption('sav');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Format').selectOption('csv');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const list = page.getByTestId('exports-list');
  await expect(list.locator('tr[data-status="done"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(list).toContainText('SPSS (.sav)');
  await shot(page, 'exports-list');
  await expectAccessible(page);

  const download = page.waitForEvent('download');
  await list
    .locator('tr', { hasText: 'CSV (UTF-8)' })
    .getByRole('link', { name: /Download/ })
    .click();
  const file = await (await download).path();
  const text = readFileSync(file, 'utf8');
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const header = text.slice(1).split('\r\n')[0]!.split(',');
  expect(header.slice(0, 3)).toEqual(['interview_id', 'case_id', 'mode']);
  expect(header).toContain('A3_SEX');
  // The 60 demo completes, plus any interview submitted by earlier tests.
  expect(text.trim().split('\r\n').length).toBeGreaterThanOrEqual(61);
});
