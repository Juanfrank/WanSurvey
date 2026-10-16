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

  // Create a point with three faces.
  const section = page.getByTestId('feedback-section');
  const name = `Ventanilla ${Date.now()}`;
  await section.getByText('New feedback point').click();
  await section.getByLabel('Name (for you)').fill(name);
  await section.getByLabel('Question').fill('¿Cómo lo atendimos hoy?');
  await section.getByRole('button', { name: 'Create' }).click();
  const row = section.locator(`[data-feedback="${name}"]`);
  const links = row.getByTestId('feedback-links');
  await expect(links).toBeVisible();
  const good = (await links.locator('code').nth(2).textContent())!;
  expect(good).toMatch(/\/f\/[\w-]+\?r=3$/);
  await shot(page, 'feedback-links');
  await expectAccessible(page, '[data-testid="feedback-section"]');

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
  await row.getByRole('link', { name: 'Print slips' }).click();
  await expect(page.getByTestId('feedback-print').locator('[data-slip]')).toHaveCount(8);
  await shot(page, 'feedback-slips');
  await page.goBack();

  // Results: the link answer, and a paper slip keyed in the office.
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();
  const again = page.getByTestId('feedback-section').locator(`[data-feedback="${name}"]`);
  await again.getByRole('button', { name: 'Results' }).click();
  const results = again.getByTestId('feedback-results');
  await expect(results.locator('[data-count="3"]')).toHaveText('1');
  await results.getByRole('button', { name: 'Key paper slips: Bad' }).click();
  await expect(results.locator('[data-count="1"]')).toHaveText('1');
  await expect(results).toContainText('Muy amables');
  await expect(results).toContainText('Links 1 · Widget 0 · Paper 1');
});
