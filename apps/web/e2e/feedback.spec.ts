import { devices, expect, test } from '@playwright/test';
import { PM, expectAccessible, login, pickOrganisation, shot } from './helpers.js';

test('a face link records the answer; slips print; results count every channel', async ({
  page,
  browser,
}) => {
  await login(page, PM);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByRole('link', { name: 'Household Survey 2026' }).click();
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();

  // Quick feedback is created like any questionnaire, as another format.
  const name = `Ventanilla ${Date.now()}`;
  await page
    .getByTestId('new-format')
    .getByRole('radio', { name: /Quick feedback/ })
    .check();
  await page.getByLabel('Name (for you)').fill(name);
  await page.getByLabel('Question', { exact: true }).fill('¿Cómo lo atendimos hoy?');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const links = page.getByTestId('feedback-links');
  await expect(links).toBeVisible();
  const good = (await links.locator('code').nth(2).textContent())!;
  expect(good).toMatch(/\/f\/[\w-]+\?r=3$/);
  await shot(page, 'feedback-links');
  await expectAccessible(page);
  // It is listed with the questionnaires, with its own actions.
  await page.getByRole('button', { name: 'Back to questionnaires' }).click();
  const row = page.getByTestId('questionnaires').locator(`[data-feedback="${name}"]`);
  await expect(row).toContainText('Faces');
  await expect(row).toContainText('0 answers');
  const actions = async () => {
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    return page.getByRole('menu', { name: `Actions for ${name}` });
  };

  // Someone opens the "good" face from an e-mail on a phone, and adds a comment.
  const phone = await browser.newContext({ ...devices['Pixel 7'], storageState: undefined });
  const r = await phone.newPage();
  await r.goto(new URL(good).pathname + new URL(good).search + '&ref=ticket-7');
  await expect(r.getByRole('status').first()).toHaveText('¡Gracias por su opinión!');
  await expect(r.getByRole('button', { name: /Bien/ })).toHaveAttribute('aria-pressed', 'true');
  await r.getByLabel(/Quiere contarnos algo más/).fill('Muy amables');
  await r.getByRole('button', { name: 'Enviar comentario' }).click();
  await expect(r.getByText('Comentario enviado. ¡Gracias!')).toBeVisible();
  await shot(r, 'feedback-phone');
  // A reload does not count the face twice.
  await r.reload();
  await expect(r.getByRole('status').first()).toHaveText('¡Gracias por su opinión!');
  await phone.close();

  // Slips to print, eight per page.
  await (await actions()).getByRole('menuitem', { name: 'Print slips' }).click();
  await expect(page.getByTestId('feedback-print').locator('[data-slip]')).toHaveCount(8);
  await shot(page, 'feedback-slips');
  await page.goBack();

  // Results: the link answer, and a paper slip keyed in the office.
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();
  await (await actions()).getByRole('menuitem', { name: 'Results' }).click();
  const results = page.getByTestId('feedback-results');
  await expect(results.locator('[data-count="3"]')).toHaveText('1');
  await results.getByRole('button', { name: 'Key paper slips: Bad' }).click();
  await expect(results.locator('[data-count="1"]')).toHaveText('1');
  await expect(results).toContainText('Muy amables');
  await expect(results).toContainText('Links 1 · Widget 0 · Paper 1');

  // Answered points cannot be deleted: they are switched off instead.
  await page.getByRole('button', { name: 'Back to questionnaires' }).click();
  page.once('dialog', (d) => void d.accept());
  await (await actions()).getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.getByText('It already has answers: switch it off instead')).toBeVisible();
  await (await actions()).getByRole('menuitem', { name: 'Switch off' }).click();
  await expect(row).toContainText('Switched off');
});
