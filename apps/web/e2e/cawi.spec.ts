import { devices, expect, test, type Page } from '@playwright/test';
import { PM, expectAccessible, login, shot } from './helpers.js';
import { sentMail } from './mail.js';

async function openProject(page: Page) {
  await login(page, PM);
  const org = page.getByRole('combobox', { name: 'Organisation' });
  await expect(org).toBeVisible();
  if ((await org.locator('option:checked').textContent()) !== 'Demo Research')
    await org.selectOption({ label: 'Demo Research' });
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByRole('link', { name: 'Household Survey 2026' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
}

test('a wave is e-mailed, answered on a phone with a resume, and the funnel shows it', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await openProject(page);
  await page.getByRole('tab', { name: 'Web survey' }).click();

  // Declare the lawful basis, then create and send a wave to some cases of region 3.
  await page.getByLabel('Lawful basis for e-mailing this sample').selectOption('consent');
  await page.getByLabel('Sender name').fill('Encuesta de hogares 2026');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('template-preview')).toContainText('Le invitamos');

  await page.getByLabel('Name', { exact: true }).fill('Ola 1');
  await page.getByLabel('Only cases where (optional)').fill('case.region == 3 and case.age < 45');
  await page.getByLabel('Reminders after (days)').fill('3');
  await page.getByRole('button', { name: 'Create wave' }).click();
  await expect(page.getByTestId('waves-message')).toContainText('Wave created');
  await page.getByRole('button', { name: 'Send Ola 1' }).click();
  await expect(page.getByTestId('waves-message')).toContainText(/\d+ invitations queued/);

  // The dispatcher sends them; the first e-mail has the link.
  await expect.poll(() => sentMail().length, { timeout: 20_000 }).toBeGreaterThan(0);
  const mail = sentMail()[0]!;
  expect(mail.subject).toBe('Le invitamos a responder una encuesta');
  const link = mail.text.match(/https?:\/\/\S+\/t\/c\/[A-Za-z0-9_-]+/)![0];

  // The respondent opens it on a phone: one question per page, in Spanish.
  const phone = await browser.newContext({ ...devices['Pixel 7'], storageState: undefined });
  const r = await phone.newPage();

  await r.goto(link);
  await expect(r).toHaveURL(/\/s\/[A-Za-z0-9_-]+$/);
  await expect(r.locator('[data-qkey^="A0_CONSENT_TEXT"]')).toContainText('estamos realizando');
  await shot(r, 'respondent-phone');
  await expectAccessible(r);
  await r.getByRole('button', { name: 'Siguiente' }).click();
  await expect(r.locator('[data-qkey^="A1"]')).toBeVisible();
  await expect(r.getByTestId('respondent-save')).toHaveText('Respuestas guardadas');

  // Reload: the survey continues where it was.
  await r.reload();
  await expect(r.locator('[data-qkey^="A1"]')).toBeVisible();
  await r.getByRole('radio', { name: 'No' }).check();
  await r.getByRole('button', { name: 'Siguiente' }).click();
  await r.getByRole('button', { name: 'Enviar mis respuestas' }).click();
  await expect(r.getByTestId('completed')).toContainText('¡Muchas gracias');
  await phone.close();

  // The project manager sees the funnel move.
  await page.reload();
  await page.getByRole('tab', { name: 'Web survey' }).click();
  const funnel = page.locator('[data-wave="Ola 1"]').getByTestId('funnel');
  await expect(funnel.locator('[data-step="completed"]')).toHaveAttribute('data-count', '1', {
    timeout: 15_000,
  });
  await expect(funnel.locator('[data-step="clicked"]')).toHaveAttribute('data-count', '1');
  await expect(funnel.locator('[data-step="started"]')).toHaveAttribute('data-count', '1');
  await shot(page, 'wave-funnel');
  await expectAccessible(page);
});
