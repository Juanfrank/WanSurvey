import { expect, test, type Page } from './fixtures.js';
import { sampleTable } from '@wansurvey/fixtures';
import { writeXlsx } from 'hucre/xlsx';
import { connectDb } from './db.js';
import {
  expectAccessible,
  login,
  shot,
  pickOrganisation,
  gotoTab,
  openFilters,
  closeFilters,
} from './helpers.js';

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
  return Buffer.from(await writeXlsx({ sheets: [{ name: 'Sample', rows: table }] }));
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
  // What "Personal" does, and that exact age or place can identify someone too.
  await expect(page.getByTestId('pii-help')).toContainText('Exact age, city or region');
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
  // The bubble can be dismissed with Escape without moving the pointer (WCAG 1.4.13).
  await page.keyboard.press('Escape');
  await expect(bubble).toBeHidden();
  await page.mouse.move(0, 0);
  await tip.hover();
  await expect(bubble).toBeVisible();
  // A 24 px target (WCAG 2.5.8).
  expect((await tip.boundingBox())?.width).toBeGreaterThanOrEqual(24);
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
  // Plausibility: a 100 % response is flagged; a census needs no reserves.
  await expect(selector.locator('[data-check="response_optimistic"]')).toContainText('100 %');
  await expect(selector.locator('[data-check="no_reserves"]')).toHaveCount(0);
  // The index of the steps and the state of the checks stay in view.
  const index = page.getByRole('navigation', { name: 'Steps of the selector' });
  await expect(index.getByRole('link', { name: '2 · Selection design' })).toBeVisible();
  await expect(index.getByTestId('checks-summary')).toContainText(
    'No blocking problems · 1 warning',
  );
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
  // The actions on the ticked cases float at the bottom, as a region named after them.
  await expect(page.getByRole('region', { name: '4 cases selected' })).toBeVisible();
  await shot(page, 'cases-bulk-bar', { fullPage: false });
  await expectAccessible(page);
  await page.locator('#assign-to').selectOption({ label: 'Demo clerk' });
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText('4 cases assigned.')).toBeVisible();
  const row = page.locator('tr[data-case="XHH0003"]');
  await expect(row).toContainText('Demo clerk');
  // When it was assigned, and how long ago.
  await expect(row.locator('[data-col="since"]')).toHaveText('under 1 h');
  // Hidden personal values read as such, not as a "•••" menu.
  await expect(row).toContainText('hidden');
  // The figures are the case states, the same as the dashboard's, and add up to the total.
  const kpis = page.getByRole('list', { name: 'Case figures' });
  await expect(kpis.locator('[data-kpi]')).toHaveCount(5);
  const sum = (await kpis.locator('[data-n]').allTextContents()).reduce((a, n) => a + +n, 0);
  await expect(page.getByTestId('kpi-total')).toHaveText(String(sum));
  // Readable names for the sample variables, with the code under them, in a side panel
  // opened from the list's "More" menu.
  await page.getByRole('button', { name: 'More tools of the case list' }).click();
  await page.getByRole('menuitem', { name: 'Names of the sample variables' }).click();
  const names = page.getByRole('dialog', { name: 'Names of the sample variables' });
  await page.getByRole('textbox', { name: 'Name of first_name' }).fill('First name');
  await page.getByRole('button', { name: 'Save names' }).click();
  await expect(page.getByText('1 name saved.')).toBeVisible();
  await expect(page.getByTestId('cases-table').locator('thead')).toContainText('First name');
  await shot(page, 'cases-names-drawer', { fullPage: false });
  await expectAccessible(page);
  await names.getByRole('button', { name: 'Close' }).click();
  await expect(names).toBeHidden();
  await shot(page, 'cases-list');
  await expectAccessible(page);

  // Quick filters and a team: a crew with the clerk in it, and a 72 h deadline on cases.
  const db = connectDb();
  const team = crypto.randomUUID();
  const [project] = await db.all(
    `select id, settings from projects where name = 'Household Survey 2026'`,
  );
  try {
    await db.run(
      `insert into teams (id, tenant_id, name)
       select ?, tenant_id, 'Turno mañana' from projects where id = ?`,
      [team, project!.id],
    );
    await db.run(
      `insert into team_members (team_id, user_id, tenant_id)
       select ?, u.id, p.tenant_id from users u, projects p where u.email = ? and p.id = ?`,
      [team, CLERK, project!.id],
    );
    const settings = JSON.parse((project!.settings as string | null) ?? '{}');
    await db.run(`update projects set settings = ? where id = ?`, [
      JSON.stringify({ ...settings, fieldwork: { ...settings.fieldwork, caseExpiryHours: 72 } }),
      project!.id,
    ]);
    await page.reload();
    await page.getByLabel('Search id or sample data').fill('XHH000');
    await openFilters(page);
    await page.getByRole('combobox', { name: 'Team' }).selectOption({ label: 'Turno mañana' });
    const quick = page.getByRole('group', { name: 'Quick filters' });
    await expect(quick.getByRole('button', { name: 'Due within 48 h' })).toBeVisible();
    await expect(quick.getByRole('button', { name: 'Overdue' })).toBeVisible();
    await quick.getByRole('button', { name: 'Not tried yet' }).click();
    await expect(page.getByText('Page 1 of 1 · 4 cases')).toBeVisible();
    await expect(page.locator('tr[data-case="XHH0003"]')).toContainText('Demo clerk');
    // What is on shows as chips beside the Filters button.
    await expect(page.getByRole('button', { name: 'Filters · 2' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Filters on' })).toContainText(
      'Team: Turno mañana',
    );
    await shot(page, 'v2-cases-quick-filters', { fullPage: false });
    await quick.getByRole('button', { name: 'Overdue' }).click();
    await expect(page.getByText('No cases match.')).toBeVisible();
    await quick.getByRole('button', { name: 'Overdue' }).click();
    await page.getByRole('button', { name: 'Remove filter: Team Turno mañana' }).click();
    await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
  } finally {
    await db.run(`update projects set settings = ? where id = ?`, [project!.settings, project!.id]);
    await db.run(`delete from team_members where team_id = ?`, [team]);
    await db.run(`delete from teams where id = ?`, [team]);
    await db.end();
  }

  // Cases can also be shared out at random and evenly among several people (every free
  // case, from the list's "More" menu; the ticked ones from the bar at the bottom).
  await page.getByRole('button', { name: 'More tools of the case list' }).click();
  await page.getByRole('menuitem', { name: 'Share out the free cases…' }).click();
  const share = page.getByRole('dialog', { name: 'Share out at random' });
  // Interviewers are chosen to begin with; owners and administrators sit apart, not chosen.
  await expect(share.getByRole('checkbox', { name: 'All interviewers' })).toBeChecked();
  await expect(share.getByRole('checkbox', { name: 'Demo clerk' })).toBeChecked();
  await share.getByText(/Other roles \(\d+ people\)/).click();
  await expect(share.getByRole('checkbox', { name: /Demo owner/ })).not.toBeChecked();
  await expect(share.getByRole('checkbox', { name: /Demo admin/ })).not.toBeChecked();
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

  // The project manager may reveal personal data of a case; it is recorded.
  await page.getByRole('button', { name: 'Open case XHH0003' }).click();
  const drawer = page.getByRole('dialog', { name: 'Case XHH0003' });
  await expect(drawer.getByTestId('contacts')).toContainText('•••');
  await drawer.getByRole('button', { name: 'Show personal data' }).click();
  await expect(drawer.getByTestId('contacts')).toContainText('@example.org');
  await expect(drawer).toContainText('Assigned');
  await shot(page, 'cases-detail');
  // Scrolled down, the code, status and main actions stay at the top.
  await drawer.evaluate((d) => (d.scrollTop = d.scrollHeight));
  await expect(drawer.getByTestId('case-header')).toBeInViewport();
  await expect(drawer.getByRole('heading', { name: 'History' })).toBeInViewport();
  await shot(page, 'v2-cases-detail-sticky', { fullPage: false });
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
  // The form to add a rule waits behind its button.
  await expect(page.getByLabel('Rule name')).toHaveCount(0);
  await rules.getByRole('button', { name: '+ Add rule' }).click();
  await page.getByLabel('Rule name').fill('Region 3 to the clerk');
  await page.getByLabel('Assign to').selectOption({ label: 'Demo clerk' });
  const when = page.getByRole('group', { name: 'Cases where' });
  await when.getByRole('button', { name: 'Add condition' }).click();
  await when.getByLabel('Condition 1: variable', { exact: true }).fill('case.region');
  await when.getByLabel('Condition 1: value', { exact: true }).fill('3');
  await expect(when.getByTestId('condition-summary')).toContainText('sample field "region" is 3');
  await expect(page.getByTestId('rule-preview')).toContainText(/Matches \d+ cases/);
  await page.getByLabel('At most (cases held by the person)').fill('10');
  await shot(page, 'p2-cases-rules-form', { fullPage: false });
  await rules
    .getByRole('form', { name: 'Add rule' })
    .getByRole('button', { name: 'Add rule' })
    .click();
  await expect(page.getByTestId('rules')).toContainText('Region 3 to the clerk');
  await expect(rules.getByRole('form', { name: 'Add rule' })).toHaveCount(0);
  await shot(page, 'cases-assignments', { fullPage: false });
  await expectAccessible(page);
  await rules.getByRole('button', { name: 'Close' }).last().click();

  // Back in the list, the free cases go out by the rules.
  const before = Number(await page.locator('[data-kpi="assigned"] [data-n]').textContent());
  await page.getByRole('button', { name: 'More tools of the case list' }).click();
  await page.getByRole('menuitem', { name: 'Assign free cases by the rules' }).click();
  await expect(page.getByText(/cases? assigned\./)).toBeVisible();
  await expect(page.locator('[data-kpi="assigned"] [data-n]')).not.toHaveText(String(before));
  // A wide list scrolls sideways in a named region, with the case id kept in view.
  await expect(page.getByRole('region', { name: 'Case list', exact: true })).toBeVisible();
  const idCell = page.getByTestId('cases-table').locator('tbody tr').first().locator('td').nth(1);
  await expect(idCell).toHaveCSS('position', 'sticky');
  await shot(page, 'cases-kpis');
  await page.getByRole('button', { name: 'Assignment rules' }).click();
  rules = page.getByRole('dialog', { name: 'Assignment rules' });
  const clerkRow = rules.getByTestId('workload').locator(`tr[data-person="${CLERK}"]`);
  await expect(clerkRow.locator('td[data-status="assigned"]')).toHaveText('10');
  // Field figures per person: overdue (no deadline here), callbacks, today's completes, last contact.
  await expect(clerkRow.locator('td[data-col="overdue"]')).toHaveText('—');
  await expect(clerkRow.locator('td[data-col="completes-today"]')).toHaveText('0');
  await expect(
    rules.getByTestId('workload').getByRole('columnheader', { name: 'Last contact' }),
  ).toBeVisible();
  await rules.evaluate((d) => (d.scrollTop = 0));
  // The new columns are on the right of the table's scroller.
  await rules
    .getByRole('region', { name: 'Workload' })
    .evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await shot(page, 'v2-cases-workload', { fullPage: false });
  // When someone falls ill, the cases they have not started go to another person at once.
  await rules.getByRole('button', { name: 'Move someone’s cases' }).click();
  const move = rules.getByRole('form', { name: 'Move someone’s cases' });
  await move.getByLabel('From').selectOption({ label: 'Demo clerk (10 not started)' });
  await move.getByLabel('To').selectOption({ label: 'Demo interviewer' });
  await expect(move.getByRole('button', { name: 'Move 10 cases' })).toBeEnabled();
  await move.scrollIntoViewIfNeeded();
  await shot(page, 'cases-workload-move', { fullPage: false });
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

  // A weekly goal for the interviewer, shown against their completes.
  const db = connectDb();
  const goal = crypto.randomUUID();
  // From yesterday, so it is running whatever the project's time zone.
  const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const inAMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await db.run(
    `insert into interviewer_goals (id, tenant_id, project_id, user_id, frequency, starts_on, ends_on, target)
     select ?, p.tenant_id, p.id, u.id, 'weekly', ?, ?, 10 from projects p, users u
     where p.name = 'Household Survey 2026' and u.email = ?`,
    [goal, today, inAMonth, INTERVIEWER],
  );

  // The interviewer sees names and contacts of their case without asking.
  const interviewer = await browser.newPage();
  await openProject(interviewer, INTERVIEWER);
  await interviewer.getByRole('tab', { name: 'My cases' }).click();
  await interviewer.getByLabel('Search id or sample data').fill('XHH0007');
  const row = interviewer.locator('tr[data-case="XHH0007"]');
  await expect(row).toBeVisible();
  // The search has applied (it waits for a pause in typing): only that case is listed.
  await expect(interviewer.locator('tr[data-case]')).toHaveCount(1);
  await expect(row).not.toContainText('hidden');
  // Their own figures: what to do, not what is left to assign.
  await expect(interviewer.locator('[data-kpi="todo"]')).toBeVisible();
  await expect(interviewer.locator('[data-kpi="fresh"]')).toHaveCount(0);
  await expect(interviewer.getByText(/Personal data of your cases is shown/)).toBeVisible();
  await expect(interviewer.locator('[data-kpi="goal"]')).toContainText(
    'Completes this week / goal',
  );
  await expect(interviewer.locator('[data-kpi="goal"] [data-goal]')).toContainText('/ 10');
  // Start goes straight to the interview from the list (here, choosing the mode first).
  await expect(row.getByRole('button', { name: 'Start case XHH0007' })).toBeVisible();
  await shot(interviewer, 'v2-my-cases-goal-start', { fullPage: false });
  await db.run(`delete from interviewer_goals where id = ?`, [goal]);
  await db.end();
  // On a phone, each case is a card.
  await interviewer.setViewportSize({ width: 390, height: 844 });
  const card = interviewer.locator('[data-card="XHH0007"]');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Start case XHH0007' })).toBeVisible();
  await expect(interviewer.getByTestId('cases-table')).toHaveCount(0);
  await shot(interviewer, 'v2-my-cases-phone');
  await interviewer.setViewportSize({ width: 1280, height: 720 });
  await expect(row).toBeVisible();
  await interviewer.getByRole('button', { name: 'Open case XHH0007' }).click();
  const drawer = interviewer.getByRole('dialog', { name: 'Case XHH0007' });
  await expect(drawer.getByTestId('contacts')).toContainText('@example.org');
  await expect(drawer).toContainText('Shown because you hold this case');
  await expect(drawer.getByRole('button', { name: 'Show personal data' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Close' }).click();
  // The audit entry for this first view is asserted in the API tests (admins need MFA here).

  // The project manager switches the project to an open pool.
  await gotoTab(page, 'Project settings');
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
    await openFilters(p);
    await p.getByRole('combobox', { name: /^Show/ }).selectOption({ label: 'Available to claim' });
    await closeFilters(p);
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
  // The import is in a side panel: back to the selector, then to the list.
  await page.getByRole('button', { name: 'Continue with the design' }).click();
  await expect(page.getByRole('dialog', { name: 'Add units to the sample' })).toBeHidden();

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
