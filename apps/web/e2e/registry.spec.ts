import { expect, test } from './fixtures.js';
import { expectAccessible, login, pickOrganisation, shot } from './helpers.js';

test('the people registry: add to the no-contact list, load a file, look a number up, lift it', async ({
  page,
}) => {
  await login(page);
  await pickOrganisation(page, 'Demo Research');
  await page.goto('/admin/registry');
  await expect(page.getByRole('heading', { name: 'People registry', level: 1 })).toBeVisible();

  // Add one by hand, for the phone channel only.
  await page.getByLabel('Phone or e-mail').last().fill('+51 999 000 111');
  await page.getByRole('combobox', { name: 'Reason' }).selectOption({ label: 'Not interested' });
  await page
    .getByRole('group', { name: /Channels it covers/ })
    .getByLabel('CATI')
    .check();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const row = page.getByRole('row', { name: /\+51999000111/ });
  await expect(row).toContainText('Not interested');
  await expect(row).toContainText('CATI');

  // Load a file: one person to add, one row that cannot be read.
  await page.getByLabel('No-contact list').setInputFiles({
    name: 'no-llamar.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('valor;motivo\n+51 999 000 222;no llamar\nnope;no llamar\n'),
  });
  await expect(page.getByRole('status')).toContainText('1 added');
  await expect(page.getByRole('status')).toContainText('1 not read');
  await expect(page.getByRole('row', { name: /\+51999000222/ })).toContainText('Do not contact');
  await shot(page, 'registry');
  await expectAccessible(page);

  // Look one up, then lift it.
  await page.getByLabel('Phone or e-mail').first().fill('+51999000222');
  await page.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByTestId('registry-lookup')).toContainText('Do not contact');
  await page
    .getByRole('row', { name: /\+51999000222/ })
    .getByRole('button', { name: 'Lift' })
    .click();
  await expect(page.getByRole('row', { name: /\+51999000222/ })).toHaveCount(0);
});
