import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, login, pickOrganisation, resultsSection, shot } from './helpers.js';

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
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const days = page.getByLabel(/Days an interviewer has to work a case/);
  await days.fill('30');
  await shot(page, 'settings-expiry');
  await saveSettings(page);
  await page.getByRole('tab', { name: 'Cases', exact: true }).click();
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('assigned');
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
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Fieldwork', exact: true }).click();
  const goals = page.getByTestId('goals');
  const today = new Date().toISOString().slice(0, 10);
  const inAWeek = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  await goals
    .getByRole('combobox', { name: 'For', exact: true })
    .selectOption({ label: 'Demo interviewer' });
  await goals
    .getByRole('combobox', { name: 'Frequency', exact: true })
    .selectOption({ label: 'Each business day (Mon–Fri)' });
  await goals.getByLabel('From').fill(today);
  await goals.getByLabel('To').fill(inAWeek);
  await goals.getByLabel('Completes').fill('2');
  await goals.getByRole('button', { name: 'Add goal' }).click();
  const row = goals.locator('tr[data-goal="Demo interviewer"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('2 per business day');
  // And one for the whole team, each week.
  await goals
    .getByRole('combobox', { name: 'For', exact: true })
    .selectOption({ label: 'Whole team' });
  await goals
    .getByRole('combobox', { name: 'Frequency', exact: true })
    .selectOption({ label: 'Each week' });
  await goals.getByLabel('Completes').fill('20');
  await goals.getByRole('button', { name: 'Add goal' }).click();
  const teamRow = goals.locator('tr[data-goal="Whole team"]');
  await expect(teamRow).toContainText('20 per week');
  await shot(page, 'settings-goals');
  await expectAccessible(page);

  // The metrics show their progress, without the form.
  await resultsSection(page, 'Metrics');
  const progress = page.getByTestId('goals');
  await expect(progress.locator('tr[data-goal="Whole team"]')).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Add goal' })).toHaveCount(0);

  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Fieldwork', exact: true }).click();
  for (const name of ['Demo interviewer', 'Whole team']) {
    page.once('dialog', (d) => void d.accept());
    await goals
      .locator(`tr[data-goal="${name}"]`)
      .getByRole('button', { name: /^Remove/ })
      .click();
    await expect(goals.locator(`tr[data-goal="${name}"]`)).toHaveCount(0);
  }

  // Back to no deadline, so the demo's old assigned cases do not expire under other tests.
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Assignment', exact: true }).click();
  await days.fill('');
  await saveSettings(page);
});
