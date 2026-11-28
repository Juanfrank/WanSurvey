import { expect, test } from './fixtures.js';
import { expectAccessible, login, pickOrganisation, shot } from './helpers.js';

test('the people registry: add to the no-contact list, load a file, look a number up, lift it', async ({
  page,
}) => {
  await login(page);
  await pickOrganisation(page, 'Demo Research');
  await page.goto('/admin/registry');
  await expect(page.getByRole('heading', { name: 'People registry', level: 1 })).toBeVisible();

  // Add one by hand, for the phone channel only, in a side panel over the list.
  await page.getByRole('button', { name: 'Add to the list' }).click();
  const adding = page.getByRole('dialog', { name: 'Add to the no-contact list' });
  await adding.getByLabel('Phone or e-mail').fill('+51 999 000 111');
  await adding.getByRole('combobox', { name: 'Reason' }).selectOption({ label: 'Not interested' });
  await adding
    .getByRole('group', { name: /Channels it covers/ })
    .getByLabel('CATI')
    .check();
  await shot(page, 'p2-registry-add');
  await adding.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(adding.getByRole('status')).toContainText('was added to the list');
  await adding.getByRole('button', { name: 'Done', exact: true }).click();
  const row = page.getByRole('row', { name: /\+51999000111/ });
  await expect(row).toContainText('Not interested');
  await expect(row).toContainText('CATI');

  // Load a file: one person to add, one row that cannot be read.
  await page.getByRole('button', { name: /^More tools of the registry/ }).click();
  await page.getByRole('menuitem', { name: 'Load files…' }).click();
  const loads = page.getByRole('dialog', { name: 'Load files' });
  await loads.getByLabel('No-contact list').setInputFiles({
    name: 'no-llamar.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('valor;motivo\n+51 999 000 222;no llamar\nnope;no llamar\n'),
  });
  await expect(loads.getByRole('status')).toContainText('1 added');
  await expect(loads.getByRole('status')).toContainText('1 not read');
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(loads).toBeHidden();
  await expect(page.getByRole('row', { name: /\+51999000222/ })).toContainText('Do not contact');
  await shot(page, 'registry');
  await expectAccessible(page);

  // Look one up, then lift it.
  await page.getByRole('button', { name: 'Look up…' }).click();
  const lookup = page.getByRole('dialog', { name: 'Look up a phone or e-mail' });
  await lookup.getByLabel('Phone or e-mail').fill('+51999000222');
  await lookup.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(lookup.getByTestId('registry-lookup')).toContainText('Do not contact');
  await shot(page, 'p2-registry-lookup');
  await page.keyboard.press('Escape');
  await expect(lookup).toBeHidden();
  await page
    .getByRole('row', { name: /\+51999000222/ })
    .getByRole('button', { name: 'Lift' })
    .click();
  await expect(page.getByRole('row', { name: /\+51999000222/ })).toHaveCount(0);
});
