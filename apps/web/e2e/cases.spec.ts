import { expect, test, type Page } from '@playwright/test';
import { sampleTable } from '@wansurvey/fixtures';
import ExcelJS from 'exceljs';
import { expectAccessible, login, shot } from './helpers.js';

const CLERK = 'data.entry@demo.wansurvey.test';

async function openProject(page: Page, email?: string) {
  await login(page, email);
  const org = page.getByRole('combobox', { name: 'Organisation' });
  await expect(org).toBeVisible();
  if ((await org.locator('option:checked').textContent()) !== 'Demo Research')
    await org.selectOption({ label: 'Demo Research' });
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByRole('link', { name: 'Household Survey 2026' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
}

/** 12 households with ids X…, two bad e-mails and a repeated id, as an .xlsx file. */
async function sampleXlsx(): Promise<Buffer> {
  const table = sampleTable(12, true).map((r, i) => (i === 0 ? r : [`X${r[0]}`, ...r.slice(1)]));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sample');
  table.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('import a sample from Excel: map, see the problems, leave them out, create the cases', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('tab', { name: 'Import sample' }).click();
  await page.getByLabel('Sample file (.csv or .xlsx)').setInputFiles({
    name: 'households.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await sampleXlsx(),
  });
  await page.getByRole('button', { name: 'Upload and read' }).click();
  await expect(page.getByText('13 rows read from households.xlsx.')).toBeVisible();

  // Suggested mapping: id, personal names, phone and e-mail contacts.
  const mapping = page.getByTestId('mapping-table');
  await expect(mapping.getByLabel('Becomes: id')).toHaveValue('externalId');
  await expect(mapping.getByLabel('Becomes: phone')).toHaveValue('phone');
  await expect(mapping.getByLabel('Personal: first_name')).toBeChecked();
  await expect(mapping.getByLabel('Type: region')).toHaveValue('number');
  await page.getByLabel('Country code for phones without one').fill('51');
  await shot(page, 'cases-import-mapping');
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Check the file' }).click();
  const report = page.getByTestId('import-report');
  await expect(report.locator('[data-stat="valid"] dd')).toHaveText('10');
  await expect(report.locator('[data-stat="invalid"] dd')).toHaveText('3');
  const issues = page.getByTestId('import-issues');
  await expect(issues.locator('[data-issue="invalid_email"]')).toContainText('2');
  await expect(issues.locator('[data-issue="duplicate_id"]')).toContainText('1');
  await expect(page.getByRole('button', { name: 'Create 10 cases' })).toBeDisabled();
  await page.getByLabel('Leave out the 3 rows with problems').check();
  await shot(page, 'cases-import-report');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Create 10 cases' }).click();
  await expect(page.getByTestId('import-done')).toContainText('10 cases created');
  await expect(page.getByTestId('import-done')).toContainText('rows left out');

  await page.getByRole('button', { name: 'View the cases' }).click();
  await page.getByLabel('Search id or sample data').fill('XHH');
  await expect(page.getByText('Page 1 of 1 · 10 cases')).toBeVisible();
});

test('bulk-assign cases; the clerk sees only theirs, with personal data hidden', async ({
  page,
  browser,
}) => {
  await openProject(page);
  await page.getByRole('tab', { name: 'Cases' }).click();
  await page.getByLabel('Search id or sample data').fill('XHH000');
  // XHH0005 was left out of the import (bad e-mail).
  await expect(page.getByText('Page 1 of 1 · 8 cases')).toBeVisible();
  await page.getByLabel('Select case XHH0002').check();
  await page.getByLabel('Select case XHH0006', { exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.getByText('4 selected')).toBeVisible();
  await page.locator('#assign-to').selectOption({ label: 'Demo data_entry' });
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText('4 cases assigned.')).toBeVisible();
  const row = page.locator('tr[data-case="XHH0003"]');
  await expect(row).toContainText('Demo data_entry');
  await expect(row).toContainText('•••');
  await shot(page, 'cases-list');
  await expectAccessible(page);

  // The project manager may reveal personal data of a case; it is recorded.
  await page.getByRole('button', { name: 'Open case XHH0003' }).click();
  const drawer = page.getByRole('dialog', { name: 'Case XHH0003' });
  await expect(drawer.getByTestId('contacts')).toContainText('•••');
  await drawer.getByRole('button', { name: 'Show personal data' }).click();
  await expect(drawer.getByTestId('contacts')).toContainText('@example.org');
  await expect(drawer).toContainText('Assigned');
  await shot(page, 'cases-detail');
  await drawer.getByRole('button', { name: 'Close' }).click();

  const clerk = await browser.newPage();
  await openProject(clerk, CLERK);
  await expect(clerk.getByRole('tab', { name: 'My cases' })).toBeVisible();
  await clerk.getByRole('tab', { name: 'My cases' }).click();
  const table = clerk.getByTestId('cases-table');
  await expect(table.locator('tbody tr')).toHaveCount(4);
  await expect(table).toContainText('XHH0002');
  await expect(table).not.toContainText('HH0001 ');
  await clerk.getByRole('button', { name: 'Open case XHH0004' }).click();
  const d = clerk.getByRole('dialog', { name: 'Case XHH0004' });
  await expect(d.getByTestId('contacts')).toContainText('•••');
  await expect(d.getByRole('button', { name: 'Show personal data' })).toHaveCount(0);
});

test('an assignment rule gives matching unassigned cases to a person', async ({ page }) => {
  await openProject(page);
  await page.getByRole('tab', { name: 'Assignments' }).click();
  await expect(page.getByTestId('rules')).toContainText('Region 1');
  await page.getByLabel('Rule name').fill('Region 3 to the clerk');
  await page.getByLabel('Assign to').selectOption({ label: 'Demo data_entry' });
  const when = page.getByRole('group', { name: 'Cases where' });
  await when.getByRole('button', { name: 'Add condition' }).click();
  await when.getByLabel('Condition 1: variable', { exact: true }).fill('case.region');
  await when.getByLabel('Condition 1: value', { exact: true }).fill('3');
  await expect(when.getByTestId('condition-summary')).toContainText('sample field "region" is 3');
  await expect(page.getByTestId('rule-preview')).toContainText(/Matches \d+ cases/);
  await page.getByLabel('At most (cases held by the person)').fill('10');
  await page.getByRole('button', { name: 'Add rule' }).last().click();
  await expect(page.getByTestId('rules')).toContainText('Region 3 to the clerk');
  await page.getByRole('button', { name: 'Apply rules to unassigned cases now' }).click();
  await expect(page.getByText(/cases? assigned\./)).toBeVisible();
  const clerkRow = page.getByTestId('workload').locator(`tr[data-person="${CLERK}"]`);
  await expect(clerkRow.locator('td').first()).toHaveText('10');
  await shot(page, 'cases-assignments');
  await expectAccessible(page);
});

test('interviewers see their cases automatically; in pool mode the first to take a case holds it', async ({
  page,
  browser,
}) => {
  const INTERVIEWER = 'interviewer@demo.wansurvey.test';
  await openProject(page);
  await page.getByRole('tab', { name: 'Cases' }).click();
  await page.getByLabel('Search id or sample data').fill('XHH0007');
  await page.getByLabel('Select case XHH0007').check();
  await page.locator('#assign-to').selectOption({ label: 'Demo interviewer' });
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText(/cases? assigned\./)).toBeVisible();
  await expect(page.locator('tr[data-case="XHH0007"]')).toContainText('Demo interviewer');

  // The interviewer sees names and contacts of their case without asking.
  const interviewer = await browser.newPage();
  await openProject(interviewer, INTERVIEWER);
  await interviewer.getByRole('tab', { name: 'My cases' }).click();
  await interviewer.getByLabel('Search id or sample data').fill('XHH0007');
  const row = interviewer.locator('tr[data-case="XHH0007"]');
  await expect(row).toBeVisible();
  await expect(row).not.toContainText('•••');
  await expect(interviewer.getByText(/Personal data of your cases is shown/)).toBeVisible();
  await interviewer.getByRole('button', { name: 'Open case XHH0007' }).click();
  const drawer = interviewer.getByRole('dialog', { name: 'Case XHH0007' });
  await expect(drawer.getByTestId('contacts')).toContainText('@example.org');
  await expect(drawer).toContainText('Shown because you hold this case');
  await expect(drawer.getByRole('button', { name: 'Show personal data' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Close' }).click();
  // The audit entry for this first view is asserted in the API tests (admins need MFA here).

  // The project manager switches the project to an open pool.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: /Open pool/ }).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await shot(page, 'project-settings');
  await expectAccessible(page);

  // Two people open the same free case; the first to take it holds it.
  const clerk = await browser.newPage();
  await openProject(clerk, CLERK);
  for (const p of [interviewer, clerk]) {
    await p.reload();
    await p.getByRole('tab', { name: 'My cases' }).click();
    await p.getByLabel('Show').selectOption({ label: 'Available to claim' });
  }
  const free = interviewer.locator('[data-testid="cases-table"] tbody tr').first();
  await expect(free).toContainText('Available');
  const id = (await free.getAttribute('data-case'))!;
  const drawers = [];
  for (const p of [interviewer, clerk]) {
    await p.getByRole('button', { name: `Open case ${id}`, exact: true }).click();
    drawers.push(p.getByRole('dialog', { name: `Case ${id}` }));
  }
  await drawers[0]!.getByRole('button', { name: 'Take this case' }).click();
  await expect(drawers[0]!).toContainText('The case is yours now.');
  await expect(drawers[0]!.getByRole('button', { name: 'Give the case back' })).toBeVisible();
  await shot(interviewer, 'cases-pool-claimed');
  await expectAccessible(interviewer);
  await drawers[1]!.getByRole('button', { name: 'Take this case' }).click();
  await expect(drawers[1]!).toContainText('Someone else has just taken this case.');

  // Back to supervisor assignment for the other tests.
  await page.getByRole('radio', { name: /Assigned by a supervisor/ }).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
});
