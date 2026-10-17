import { expect, test } from '@playwright/test';
import { expectAccessible, login, pickOrganisation, shot } from './helpers.js';

test('a questionnaire is disabled, enabled again, and completed with a continuation', async ({
  page,
}) => {
  await login(page);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();

  // A questionnaire of its own, so the demo ones stay as they are.
  const csrf = (await page.context().cookies()).find((c) => c.name === 'ws_csrf')!.value;
  const projectId = new URL(page.url()).pathname.split('/')[2]!;
  const name = `Pilot ${Date.now() % 100000}`;
  const made = await page.request.post(`/api/v1/projects/${projectId}/questionnaires`, {
    headers: { 'x-csrf-token': csrf },
    data: { name, modes: ['CAWI'] },
  });
  expect(made.ok()).toBe(true);
  await page.reload();
  const row = page.getByRole('row').filter({ hasText: name });
  const actions = () => row.getByRole('button', { name: `Actions for ${name}` }).click();

  page.once('dialog', (d) => void d.accept());
  await actions();
  await page.getByRole('menuitem', { name: 'Disable' }).click();
  await expect(page.getByText(`${name} was disabled.`)).toBeVisible();
  await expect(row.getByTestId('q-state')).toContainText('Disabled');
  await actions();
  await page.getByRole('menuitem', { name: 'Enable again' }).click();
  await expect(row.getByTestId('q-state')).not.toContainText('Disabled');

  await actions();
  await page.getByRole('menuitem', { name: 'Complete…' }).click();
  const dialog = page.getByRole('dialog', { name: `Complete “${name}”` });
  await dialog
    .getByRole('combobox', { name: 'Continue in (optional)' })
    .selectOption({ label: 'Household questionnaire' });
  await shot(page, 'complete-dialog');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(row.getByTestId('q-state')).toContainText('Completed');
  await expect(row.getByTestId('q-state')).toContainText('continues in Household questionnaire');
  await shot(page, 'questionnaire-states');
  await expectAccessible(page);

  // Reopened, then removed.
  await actions();
  await page.getByRole('menuitem', { name: 'Reopen' }).click();
  await expect(row.getByTestId('q-state')).not.toContainText('Completed');
  page.once('dialog', (d) => void d.accept());
  await actions();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(row).toHaveCount(0);
});
