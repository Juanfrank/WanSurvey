import { expect, test, type Page } from './fixtures.js';
import {
  expectAccessible,
  login,
  pickOrganisation,
  resultsSection,
  shot,
  gotoTab,
  openFilters,
  closeFilters,
} from './helpers.js';

async function openProject(page: Page) {
  await login(page);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
}

async function saveSettings(page: Page) {
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
}

test('a deadline for assigned cases, cross-case checks in the plan, and goals per interviewer', async ({
  page,
}) => {
  await openProject(page);

  // Cases expire 30 days after assignment; the list says when.
  await gotoTab(page, 'Project settings');
  const days = page.getByLabel(/Time an interviewer has to work a case/);
  await days.fill('30');
  await shot(page, 'settings-expiry');
  await saveSettings(page);
  await page.getByRole('tab', { name: 'Cases', exact: true }).click();
  await openFilters(page);
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('assigned');
  await closeFilters(page);
  await expect(page.locator('[data-col="due"]').first()).toContainText('expires');
  await shot(page, 'cases-expiry');

  // A cross-case check: not eligible if the same phone answered in any project in 180 days.
  await page.getByRole('tab', { name: 'Sampling selector' }).click();
  const checks = page.getByTestId('cross-checks');
  await checks.getByRole('button', { name: 'Add a cross-case check' }).click();
  const rule = checks.locator('[data-cross-check="1"]');
  await expect(rule.getByTestId('cross-check-summary')).toHaveText('Choose at least one field.');
  await rule.getByRole('checkbox', { name: 'Phone' }).check();
  await rule
    .getByLabel('Rule 1: look in')
    .selectOption({ label: 'All the projects of the organisation' });
  await expect(rule.getByTestId('cross-check-summary')).toContainText(
    'Not eligible if Phone matches someone with that result in the last 180 days',
  );
  await shot(page, 'sampling-cross-checks');
  await expectAccessible(page);
  // Leave the shared demo plan as it was.
  await rule.getByRole('button', { name: 'Remove rule 1' }).click();
  await expect(checks.locator('[data-cross-check]')).toHaveCount(0);

  // Goals are set in the settings: the demo interviewer, 2 completes each business day.
  await gotoTab(page, 'Project settings');
  await page.getByRole('tab', { name: 'Goals', exact: true }).click();
  const goals = page.getByTestId('goals');
  const today = new Date().toISOString().slice(0, 10);
  const inAWeek = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  // The form of a goal opens in a side panel from "+ Add goal" beside the title.
  await expect(page.getByLabel('Completes', { exact: true })).toHaveCount(0);
  await goals.getByRole('button', { name: 'Add goal' }).click();
  let form = page.getByRole('dialog', { name: 'New goal' });
  await form
    .getByRole('combobox', { name: 'For', exact: true })
    .selectOption({ label: 'Demo interviewer' });
  await form
    .getByRole('combobox', { name: 'Frequency', exact: true })
    .selectOption({ label: 'Each business day (Mon–Fri)' });
  await form.getByLabel('From').fill(today);
  await form.getByLabel('To').fill(inAWeek);
  await form.getByLabel('Completes').fill('2');
  await shot(page, 'settings-goals-drawer', { fullPage: false });
  await expectAccessible(page);
  await form.getByRole('button', { name: 'Add goal' }).click();
  await expect(form).toHaveCount(0);
  const row = goals.locator('tr[data-goal="Demo interviewer"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('2 per business day');
  // And one for the whole team, each week.
  await goals.getByRole('button', { name: 'Add goal' }).click();
  form = page.getByRole('dialog', { name: 'New goal' });
  await form
    .getByRole('combobox', { name: 'For', exact: true })
    .selectOption({ label: 'Whole team' });
  await form
    .getByRole('combobox', { name: 'Frequency', exact: true })
    .selectOption({ label: 'Each week' });
  await form.getByLabel('From').fill(today);
  await form.getByLabel('To').fill(inAWeek);
  await form.getByLabel('Completes').fill('20');
  await form.getByRole('button', { name: 'Add goal' }).click();
  await expect(form).toHaveCount(0);
  const teamRow = goals.locator('tr[data-goal="Whole team"]');
  await expect(teamRow).toContainText('20 per week');
  await shot(page, 'settings-goals');
  await expectAccessible(page);

  // The planned fieldwork dates: the dashboard shows the pace and the goals' state.
  const fieldwork = page.getByTestId('fieldwork-settings');
  const started = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
  await fieldwork.getByLabel('Fieldwork starts').fill(started);
  await fieldwork.getByLabel('Fieldwork ends').fill(inAWeek);
  await saveSettings(page);
  await resultsSection(page, 'Dashboard');
  const pace = page.getByTestId('pace');
  await expect(pace).toBeVisible();
  await expect(pace.getByTestId('pace-state')).toHaveText(/On track|Behind|Target met/);
  await expect(page.getByTestId('dashboard-goals')).toContainText('Whole team');
  await expect(page.getByTestId('quotas').locator('tbody tr').first()).toHaveAttribute(
    'data-state',
    /.+/,
  );
  await shot(page, 'dashboard-pace');
  // How long personal data is kept, and what happens then, on the overview.
  await expect(page.getByTestId('retention-notice')).toContainText('Personal data retention');
  await shot(page, 'v2-overview-retention', { fullPage: false });
  await expectAccessible(page);

  // The project's status, with what is still open before closing it (left as it is).
  await gotoTab(page, 'Project settings');
  await page.getByRole('tab', { name: 'Project status', exact: true }).click();
  const status = page.getByTestId('project-status');
  await expect(status.getByRole('button', { name: 'Close the project' })).toBeVisible();
  await expect(status.getByTestId('closeout').locator('li[data-item="openCases"]')).toContainText(
    'still open',
  );
  await shot(page, 'project-status');
  await expectAccessible(page);
  await page.getByRole('tab', { name: 'Goals', exact: true }).click();
  await fieldwork.getByLabel('Fieldwork starts').fill('');
  await fieldwork.getByLabel('Fieldwork ends').fill('');
  await saveSettings(page);

  // The metrics show their progress, without the form.
  await resultsSection(page, 'Metrics');
  const progress = page.getByTestId('goals');
  await expect(progress.locator('tr[data-goal="Whole team"]')).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Add goal' })).toHaveCount(0);

  await gotoTab(page, 'Project settings');
  await page.getByRole('tab', { name: 'Goals', exact: true }).click();
  for (const name of ['Demo interviewer', 'Whole team']) {
    page.once('dialog', (d) => void d.accept());
    await goals
      .locator(`tr[data-goal="${name}"]`)
      .getByRole('button', { name: /^Remove/ })
      .click();
    await expect(goals.locator(`tr[data-goal="${name}"]`)).toHaveCount(0);
  }

  // Back to no deadline, so the demo's old assigned cases do not expire under other tests.
  await gotoTab(page, 'Project settings');
  await page.getByRole('tab', { name: 'Assignment', exact: true }).click();
  await days.fill('');
  await saveSettings(page);
});
