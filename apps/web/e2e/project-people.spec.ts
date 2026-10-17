import { expect, test } from '@playwright/test';
import { expectAccessible, login, shot } from './helpers.js';

test('the project manager gives someone a role in the project, from the project', async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await page.getByRole('tab', { name: 'People', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'People of the project' })).toBeVisible();

  await page.getByRole('button', { name: 'Add a person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a person' });
  // A manager gives roles from supervisor down.
  await expect(dialog.getByRole('radio', { name: /^Project manager/ })).toHaveCount(0);
  await dialog
    .getByRole('combobox', { name: 'Person' })
    .selectOption({ label: 'Demo client_viewer · client.viewer@demo.wansurvey.test' });
  await dialog.getByRole('radio', { name: /^Reviewer/ }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Demo client_viewer is now Reviewer in this project.')).toBeVisible();
  const row = page.locator('tr[data-person="client.viewer@demo.wansurvey.test"]');
  await expect(row).toContainText('Reviewer');
  await expect(row).toContainText('Client (read only)');
  await shot(page, 'project-people');
  await expectAccessible(page);

  // Back as it was for the other tests.
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Remove Demo client_viewer from the project' }).click();
  await expect(page.getByText('Demo client_viewer left the project.')).toBeVisible();
  await expect(row).toHaveCount(0);
});
