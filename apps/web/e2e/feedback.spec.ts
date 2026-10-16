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

  // A Likert is created like any questionnaire, as another format.
  const name = `Ventanilla ${Date.now()}`;
  await page
    .getByTestId('new-format')
    .getByRole('radio', { name: /Likert/ })
    .check();
  await page.getByLabel('Name (for you)').fill(name);
  await page.getByLabel('Question', { exact: true }).fill('¿Cómo lo atendimos hoy?');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // Its questions: the Likert first, the comment box, and a branch the link can answer.
  const designer = page.getByTestId('feedback-designer');
  await expect(designer.locator('[data-item="LIKERT"]')).toBeVisible();
  await expect(designer.locator('[data-item="COMENTARIO"]')).toBeVisible();
  await designer.getByRole('button', { name: '+ Single choice' }).click();
  const branch = designer.locator('li').last();
  await branch.getByRole('textbox').first().fill('SEDE');
  await branch.getByLabel(/^Text of/).fill('¿A cuál sede acudió?');
  await branch.getByLabel(/^Answer 1 of/).fill('Centro');
  await branch.getByLabel(/^Answer 2 of/).fill('Norte');
  await branch.getByLabel('Link parameter (optional)').fill('sede');
  await designer.getByRole('button', { name: 'Save the questions' }).click();
  await expect(designer.getByRole('status')).toHaveText('Saved as version 2.');
  await expect(designer.getByTestId('feedback-count')).toHaveText(
    '2 of 5 questions after the Likert',
  );
  await shot(page, 'feedback-designer');
  await expectAccessible(page);

  // It is listed with the questionnaires, as a Likert with its version and status.
  await page.getByRole('button', { name: 'Back to questionnaires' }).click();
  const row = page.getByTestId('questionnaires').locator(`[data-feedback="${name}"]`);
  await expect(row).toContainText('LIKERT');
  await expect(row).toContainText('v2');
  await expect(row).toContainText('Active · 0 answers');
  const actions = async () => {
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    return page.getByRole('menu', { name: `Actions for ${name}` });
  };
  await (await actions()).getByRole('menuitem', { name: 'Links and embedding' }).click();
  const links = page.getByTestId('feedback-links');
  await expect(links).toBeVisible();
  const good = (await links.locator('code').nth(2).textContent())!;
  expect(good).toMatch(/\/f\/[\w-]+\?r=3$/);
  await shot(page, 'feedback-links');
  await page.getByRole('button', { name: 'Back to questionnaires' }).click();

  // Someone opens the "good" face from an e-mail on a phone, and adds a comment.
  const phone = await browser.newContext({ ...devices['Pixel 7'], storageState: undefined });
  const r = await phone.newPage();
  // The link says the branch (?sede=2): that question is recorded and not shown.
  await r.goto(new URL(good).pathname + new URL(good).search + '&ref=ticket-7&sede=2');
  await expect(r.getByRole('status').first()).toHaveText('¡Gracias por su opinión!');
  await expect(r.getByRole('button', { name: /Bien/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(r.locator('[data-followup="SEDE"]')).toHaveCount(0);
  await r.getByLabel(/Quiere contarnos algo más/).fill('Muy amables');
  await r.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(r.getByText('Respuestas enviadas. ¡Gracias!')).toBeVisible();
  await shot(r, 'feedback-phone');
  // A reload does not count the face twice.
  await r.reload();
  await expect(r.getByRole('status').first()).toHaveText('¡Gracias por su opinión!');
  await phone.close();

  // Slips to print, eight per page.
  await (await actions()).getByRole('menuitem', { name: 'Print slips' }).click();
  const print = page.getByTestId('feedback-print');
  await expect(print.locator('[data-slip]')).toHaveCount(6);
  await expect(print.locator('[data-slip-item="SEDE"]')).toHaveCount(6);
  // A print run for one branch: the branch is fixed in the QR link and not asked.
  await page.getByLabel(/On the printed slips/).selectOption({ label: 'Norte' });
  await expect(print.locator('[data-slip-item="SEDE"]')).toHaveCount(0);
  await expect(print.locator('[data-fixed]').first()).toContainText('Norte');
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
  await expect(results.locator('[data-item-results="SEDE"] [data-code="2"]')).toHaveText('1');

  // Answered points cannot be deleted: they are switched off instead.
  await page.getByRole('button', { name: 'Back to questionnaires' }).click();
  page.once('dialog', (d) => void d.accept());
  await (await actions()).getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.getByText('It already has answers: switch it off instead')).toBeVisible();
  await (await actions()).getByRole('menuitem', { name: 'Switch off' }).click();
  await expect(row).toContainText('Switched off');
});
