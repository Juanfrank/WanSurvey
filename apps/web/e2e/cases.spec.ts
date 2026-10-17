import { expect, test, type Page } from '@playwright/test';
import { sampleTable } from '@wansurvey/fixtures';
import ExcelJS from 'exceljs';
import { expectAccessible, login, shot, pickOrganisation } from './helpers.js';

const CLERK = 'data.entry@demo.wansurvey.test';

async function openProject(page: Page, email?: string) {
  await login(page, email);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
  // Questionnaires come first; the case work is in the Cases tab.
  const cases = page.getByRole('tab', { name: 'Cases', exact: true });
  if (await cases.count()) await cases.click();
}

/** 12 households with ids X…, two bad e-mails and a repeated id, as an .xlsx file. */
async function sampleXlsx(): Promise<Buffer> {
  const table = sampleTable(12, true).map((r, i) => (i === 0 ? r : [`X${r[0]}`, ...r.slice(1)]));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sample');
  table.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('sampling selector: load a frame from Excel, see the problems, select a census, get the cases', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('tab', { name: 'Sampling selector' }).click();
  const selector = page.getByTestId('sampling');
  await expect(selector.getByTestId('layer-1')).toContainText('1 · Source of the units');
  await expect(selector.getByTestId('frame-units')).toHaveText('0 units');
  await selector.getByRole('button', { name: 'Import sample' }).click();
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
  const load = page.getByRole('button', { name: 'Load 10 units into the frame' });
  await expect(load).toBeDisabled();
  await page.getByLabel('Leave out the 3 rows with problems').check();
  await shot(page, 'cases-import-report');
  await expectAccessible(page);
  await load.click();
  await expect(page.getByTestId('import-done')).toContainText(
    'Frame: 10 units added, 0 updated, 3 skipped.',
  );
  await page.getByRole('button', { name: 'Continue with the design' }).click();
  await expect(selector.getByTestId('frame-units')).toHaveText('10 units');

  // Each term has an (i): hovering or focusing it explains it, with the usual standard.
  const tip = selector.locator('[data-tip="deff"]');
  await tip.hover();
  const bubble = page.getByRole('tooltip').filter({ hasText: 'Design effect' });
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText('Suggested standard:');
  await page.mouse.move(0, 0);
  await expect(bubble).toBeHidden();
  await selector.locator('[data-tip="stratified"]').focus();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Stratified sampling' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Layer 2: every unit of the list. Layer 3: the size follows the frame; no sampling error.
  await selector
    .getByTestId('layer-2')
    .getByRole('radio', { name: /Every unit of the list/ })
    .check();
  await expect(selector.locator('[data-check="census_no_sampling_error"]')).toBeVisible();
  await expect(selector.locator('[data-size="toSelect"]')).toHaveText('10');
  await expect(selector.locator('[data-check="no_margin_of_error"]')).toHaveCount(0);
  await shot(page, 'cases-sampling', { fullPage: true });
  await expectAccessible(page);
  page.once('dialog', (d) => void d.accept());
  await selector.getByRole('button', { name: 'Select the sample and create the cases…' }).click();
  await expect(selector.getByTestId('selected-on')).toBeVisible();
  await expect(selector.locator('[data-role="main"]')).toContainText('10');

  await page.getByRole('tab', { name: 'Case list' }).click();
  await page.getByLabel('Search id or sample data').fill('XHH');
  await expect(page.getByText('Page 1 of 1 · 10 cases')).toBeVisible();
});

test('bulk-assign cases; the clerk sees only theirs, with the personal data of their cases', async ({
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
  await page.locator('#assign-to').selectOption({ label: 'Demo clerk' });
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText('4 cases assigned.')).toBeVisible();
  const row = page.locator('tr[data-case="XHH0003"]');
  await expect(row).toContainText('Demo clerk');
  // When it was assigned, and how long ago.
  await expect(row.locator('[data-col="since"]')).toHaveText('under 1 h');
  await expect(row).toContainText('•••');
  await shot(page, 'cases-list');
  await expectAccessible(page);

  // Cases can also be shared out at random and evenly among several people.
  await page
    .getByRole('combobox', { name: 'How to assign' })
    .selectOption({ label: 'At random, evenly' });
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  const share = page.getByRole('dialog', { name: 'Share out at random' });
  await share.getByRole('checkbox', { name: 'Everyone' }).check();
  await expect(share.getByRole('checkbox', { name: 'Demo clerk' })).toBeChecked();
  // The fair method: a preview of what each person would get, within its limit.
  await share
    .getByRole('combobox', { name: 'Method' })
    .selectOption({ label: 'Fair with a ceiling' });
  await share.getByRole('textbox', { name: 'At most open cases per person' }).fill('3');
  const preview = share.getByTestId('distribute-preview');
  await expect(preview.getByRole('row', { name: /Demo clerk/ })).toBeVisible();
  await expect(preview.getByRole('columnheader', { name: 'Limit' })).toBeVisible();
  await share.getByRole('combobox', { name: 'Method' }).selectOption({ label: 'By capacity' });
  await share.getByRole('checkbox', { name: 'Write the weights by hand' }).check();
  await expect(preview.getByRole('spinbutton', { name: 'Weight of Demo clerk' })).toBeVisible();
  await shot(page, 'cases-distribute');
  await expectAccessible(page);
  await share.getByRole('button', { name: 'Cancel' }).click();
  await page
    .getByRole('combobox', { name: 'How to assign' })
    .selectOption({ label: 'To a person' });

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
  // Interviewers (who also key paper forms) see the personal data of the cases they hold.
  await expect(d).toContainText('Shown because you hold this case');
  await expect(d.getByTestId('contacts')).toContainText('@example.org');
});

test('an assignment rule gives matching unassigned cases to a person', async ({ page }) => {
  await openProject(page);
  // The rules are behind the gear beside the assignment controls of the case list.
  await page.getByRole('button', { name: 'Assignment rules' }).click();
  let rules = page.getByRole('dialog', { name: 'Assignment rules' });
  await expect(rules.getByTestId('rules')).toContainText('Region 1');
  await page.getByLabel('Rule name').fill('Region 3 to the clerk');
  await page.getByLabel('Assign to').selectOption({ label: 'Demo clerk' });
  const when = page.getByRole('group', { name: 'Cases where' });
  await when.getByRole('button', { name: 'Add condition' }).click();
  await when.getByLabel('Condition 1: variable', { exact: true }).fill('case.region');
  await when.getByLabel('Condition 1: value', { exact: true }).fill('3');
  await expect(when.getByTestId('condition-summary')).toContainText('sample field "region" is 3');
  await expect(page.getByTestId('rule-preview')).toContainText(/Matches \d+ cases/);
  await page.getByLabel('At most (cases held by the person)').fill('10');
  await page.getByRole('button', { name: 'Add rule' }).last().click();
  await expect(page.getByTestId('rules')).toContainText('Region 3 to the clerk');
  await shot(page, 'cases-assignments', { fullPage: false });
  await expectAccessible(page);
  await rules.getByRole('button', { name: 'Close' }).last().click();

  // Back in the list, the free cases go out by the rules.
  const before = Number(await page.locator('[data-kpi="assigned"] p').last().textContent());
  await page.getByLabel('How to assign').selectOption({ label: 'By the rules' });
  await expect(page.getByText('Assign free cases by the rules')).toBeVisible();
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText(/cases? assigned\./)).toBeVisible();
  await expect(page.locator('[data-kpi="assigned"] p').last()).not.toHaveText(String(before));
  await shot(page, 'cases-kpis');
  await page.getByRole('button', { name: 'Assignment rules' }).click();
  rules = page.getByRole('dialog', { name: 'Assignment rules' });
  const clerkRow = rules.getByTestId('workload').locator(`tr[data-person="${CLERK}"]`);
  await expect(clerkRow.locator('td').first()).toHaveText('10');
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
    await p.getByRole('combobox', { name: /^Show/ }).selectOption({ label: 'Available to claim' });
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

test('duplicates across projects are flagged; the drawer says where the case comes from', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openProject(page);
  // Another project of the organisation already has one of these phones.
  const csrf = (await page.context().cookies()).find((c) => c.name === 'ws_csrf')!.value;
  const code = `PANEL${Date.now() % 100000}`;
  const created = await page.request.post('/api/v1/projects', {
    headers: { 'x-csrf-token': csrf },
    data: { name: `Panel ${code}`, code },
  });
  expect(created.ok()).toBe(true);
  const other = (await created.json()) as { id: string };
  const table = [
    ['id', 'first_name', 'phone', 'address'],
    [`${code}-1`, 'Rosa', '987650001', 'Av. Brasil 100, Lima'],
    [`${code}-2`, 'Luis', '987650002', 'Nowhere street 9'],
  ];
  const csv = table.map((r) => r.join(',')).join('\n');
  const up = await page.request.post(`/api/v1/projects/${other.id}/imports`, {
    headers: { 'x-csrf-token': csrf },
    multipart: { file: { name: 'panel.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } },
  });
  const upload = (await up.json()) as { id: string; suggested: object };
  await page.request.put(`/api/v1/projects/${other.id}/imports/${upload.id}/mapping`, {
    headers: { 'x-csrf-token': csrf },
    data: { ...upload.suggested, defaultCountryCode: '51' },
  });
  expect(
    (
      await page.request.post(`/api/v1/projects/${other.id}/imports/${upload.id}/commit`, {
        headers: { 'x-csrf-token': csrf },
      })
    ).ok(),
  ).toBe(true);

  // The household project adds the same phone under another id (to its census).
  await page.getByRole('tab', { name: 'Sampling selector' }).click();
  await page.getByRole('button', { name: 'Add units to the sample' }).click();
  const mine = [
    ['id', 'first_name', 'phone', 'address'],
    [`G${code}-1`, 'Rosa', '987650001', 'Av. Brasil 100, Lima'],
    [`G${code}-2`, 'Ana', '987650003', 'Jr. Ica 22, Lima'],
  ];
  await page.getByLabel('Sample file (.csv or .xlsx)').setInputFiles({
    name: 'more.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(mine.map((r) => r.join(',')).join('\n')),
  });
  await page.getByRole('button', { name: 'Upload and read' }).click();
  await page.getByLabel('Country code for phones without one').fill('51');
  await page.getByRole('button', { name: 'Check the file' }).click();
  const issues = page.getByTestId('import-issues');
  await expect(issues.locator('[data-issue="duplicate_elsewhere"]')).toContainText(`Panel ${code}`);
  await expect(page.getByTestId('import-elsewhere')).toContainText(`Panel ${code} (1 row)`);
  await shot(page, 'cases-import-duplicates');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Load 2 units into the frame' }).click();
  await expect(page.getByTestId('import-done')).toContainText('2 eligible units became cases');

  // The case drawer says where else the person is, and where the case comes from.
  await page.getByRole('tab', { name: 'Case list' }).click();
  await page.getByLabel('Search id or sample data').fill(`G${code}-1`);
  await page.getByRole('button', { name: `Open case G${code}-1` }).click();
  const drawer = page.getByRole('dialog', { name: `Case G${code}-1` });
  await expect(drawer.getByTestId('elsewhere')).toContainText(`Panel ${code} (1 case)`);
  await expect(drawer.getByTestId('case-sampling')).toContainText('Main');
  await expect(drawer.getByTestId('case-sampling')).toContainText('Probability of inclusion1');
  await drawer.getByRole('button', { name: 'Close' }).click();
});
