import { devices, expect, test, type Page } from './fixtures.js';
import {
  PM,
  expectAccessible,
  login,
  pickOrganisation,
  questionnaireAction,
  shot,
  shotOpen,
  gotoTab,
} from './helpers.js';
import { sentMail } from './mail.js';

async function openProject(page: Page) {
  await login(page, PM);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
}

test('a wave is e-mailed, answered on a phone with a resume, and the funnel shows it', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await openProject(page);

  // Declare the lawful basis in the project's web settings, then create and send an outreach
  // to some cases of region 3 from the questionnaire's Distribution tab.
  await gotoTab(page, 'Project settings');
  await page.getByRole('tab', { name: 'Web', exact: true }).click();
  await page.getByLabel('Lawful basis for e-mailing this sample').selectOption('consent');
  await page.getByLabel('Sender name').fill('Encuesta de hogares 2026');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('template-preview')).toContainText('Le invitamos');
  await shot(page, 'project-settings-web');
  await questionnaireAction(page, 'Web survey');
  await expect(page.getByRole('tab', { name: 'Web survey', selected: true })).toBeVisible();
  await shot(page, 'questionnaire-distribution-web');

  // "New outreach" opens its form in a side panel.
  await page.getByRole('button', { name: '+ New outreach' }).click();
  const form = page.getByRole('dialog', { name: 'New outreach' });
  await form.getByLabel('Name', { exact: true }).fill('Ola 1');
  await form.getByLabel('Only cases where (optional)').fill('case.region == 3 and case.age < 45');
  await form.getByLabel('Reminders after (days)').fill('3');
  await shot(page, 'p2-cawi-new-wave-drawer', { fullPage: false });
  await expectAccessible(page);
  await form.getByRole('button', { name: 'Create outreach' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId('waves-message')).toContainText('Outreach created');
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
  // The footer speaks the survey's language, not the phone's (English here), and says so.
  const footer = r.getByRole('contentinfo');
  await expect(footer).toHaveAttribute('lang', 'es');
  await expect(footer.getByRole('link')).toHaveText('Política de privacidad');
  // No keyboard hints on a phone.
  await expect(r.getByRole('button', { name: 'Siguiente' })).toHaveText('Siguiente', {
    useInnerText: true,
  });
  await shot(r, 'respondent-phone');
  // Back and Next at the bottom of the screen, under the thumb (171).
  await expect(r.getByTestId('runner-nav')).toHaveCSS('position', 'sticky');
  await expect(r.getByRole('button', { name: 'Siguiente' })).toBeInViewport();
  await shot(r, 'v2-cawi-phone-thumb-nav', { fullPage: false });
  await expectAccessible(r);
  // The move to the next page is written on the phone and then sent: wait for the send,
  // since the status already read "saved" before the click.
  const sent = r.waitForResponse(
    (res) =>
      res.url().includes('/sync') &&
      res.request().method() === 'POST' &&
      (res.request().postData() ?? '').includes('"key":"A1') &&
      res.ok(),
  );
  await r.getByRole('button', { name: 'Siguiente' }).click();
  await expect(r.locator('[data-qkey^="A1"]')).toBeVisible();
  await sent;
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
  const funnel = page.locator('[data-wave="Ola 1"]').getByTestId('funnel');
  await expect(funnel.locator('[data-step="completed"]')).toHaveAttribute('data-count', '1', {
    timeout: 15_000,
  });
  await expect(funnel.locator('[data-step="clicked"]')).toHaveAttribute('data-count', '1');
  await expect(funnel.locator('[data-step="started"]')).toHaveAttribute('data-count', '1');
  await shot(page, 'wave-funnel');
  await expectAccessible(page);
});

test('a links-only wave makes a personal link per case, ready to download', async ({
  page,
  browser,
}) => {
  await openProject(page);
  await questionnaireAction(page, 'Web survey');
  await page.getByRole('button', { name: '+ New outreach' }).click();
  const form = page.getByRole('dialog', { name: 'New outreach' });
  await form.getByLabel('Name', { exact: true }).fill('Enlaces región 3');
  await form.getByLabel('Only cases where (optional)').fill('case.region == 3 and case.age >= 45');
  await form.getByRole('radio', { name: /Personal links only/ }).check();
  await expect(form.getByLabel('Reminders after (days)')).toBeHidden();
  // The links can be given an end date (each one can be changed later).
  const inAMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await form.getByLabel('Links expire on (optional)').fill(inAMonth);
  await form.getByRole('button', { name: 'Create outreach' }).click();
  await expect(
    page.locator('[data-wave="Enlaces región 3"]').getByTestId('wave-expiry'),
  ).toContainText(inAMonth);
  await page.getByRole('button', { name: 'Make the links of Enlaces región 3' }).click();
  await expect(page.getByTestId('waves-message')).toContainText(/\d+ personal links? made/);
  const links = page.getByTestId('wave-links');
  // Like passwords: the token is cut short on screen until it is shown, one link at a time.
  const first = links.locator('[data-link]').first();
  await expect(first).toContainText(/\/s\/[A-Za-z0-9_-]{4}…/);
  await expect(links.getByRole('note')).toContainText('Treat these links like passwords');
  // Show, copy, change the expiry date and revoke are in each row's "⋯".
  const firstId = (await first.getAttribute('data-link'))!;
  const rowMenu = async (id: string, item: string | RegExp) => {
    await links.getByRole('button', { name: `Actions for the link of ${id}` }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  await rowMenu(firstId, /^Show the link of /);
  await expect(first).toContainText(/\/s\/[A-Za-z0-9_-]{20,}/);
  await rowMenu(firstId, /^Hide the link of /);
  await expect(first).toContainText(/\/s\/[A-Za-z0-9_-]{4}…/);
  // The link builder waits behind "Link parameters"; the household questionnaire has no
  // question that takes a parameter.
  await expect(links.getByTestId('link-builder')).toBeHidden();
  await links.getByRole('button', { name: /^Link parameters/ }).click();
  await expect(links.getByTestId('link-builder')).toBeVisible();
  await expect(links.getByTestId('builder-none')).toContainText('Link parameter');
  // A parameter for every link, e.g. the branch.
  await links.getByLabel('Other parameters for every link (advanced, optional)').fill('sede=2');
  await expect(links.locator('[data-link]').first()).toContainText('?sede=2');
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    links.getByRole('button', { name: 'Download (CSV)' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^Enlaces.*\.csv$/);
  await shot(page, 'cawi-personal-links');

  // Each link has its end date, which can be changed, and can be revoked on its own.
  const second = links.locator('[data-link]').nth(1);
  const id = (await second.getAttribute('data-link'))!;
  await expect(second.getByTestId('link-expiry')).toHaveText(inAMonth);
  const inTwoMonths = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  await rowMenu(id, 'Change the expiry date…');
  const dating = page.getByRole('dialog', { name: `Expiry date of the link of ${id}` });
  await expect(dating.getByLabel(`Expiry date of the link of ${id}`)).toHaveValue(inAMonth);
  await dating.getByLabel(`Expiry date of the link of ${id}`).fill(inTwoMonths);
  await dating.getByRole('button', { name: 'Save' }).click();
  await expect(dating).toBeHidden();
  await expect(links.getByTestId('links-note')).toContainText(
    `The link of ${id} expires on ${inTwoMonths}.`,
  );
  await expect(second.getByTestId('link-expiry')).toHaveText(inTwoMonths);
  await rowMenu(id, `Show the link of ${id}`);
  const url = (await second.locator('td').nth(1).innerText()).replace(/\?.*$/, '').trim();
  page.once('dialog', (d) => void d.accept());
  await rowMenu(id, `Revoke the link of ${id}`);
  await expect(links.getByTestId('links-note')).toContainText(`The link of ${id} was revoked.`);
  await expect(second).toContainText('Revoked');
  await links.getByRole('button', { name: `Actions for the link of ${id}` }).click();
  await expect(page.getByRole('menuitem', { name: `Revoke the link of ${id}` })).toBeDisabled();
  // The menu is this row's: its "⋯" is the one expanded, no other row's.
  await expect(
    links.getByRole('button', { name: `Actions for the link of ${id}` }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(links.locator('[data-more-menu][aria-expanded="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  // Opened again in Spanish for the picture: switching the text moves the rows, and a menu
  // opened before would be left where its row used to be.
  await shotOpen(
    page,
    'p2-cawi-link-row-menu',
    async () => {
      await second.locator('[data-more-menu]').click();
      await expect(page.getByRole('menu')).toBeVisible();
    },
    { fullPage: false },
  );
  await shot(page, 'v2-cawi-links-expiry-revoke');
  await expectAccessible(page);

  // Whoever opens the revoked link is told so, in the survey's language.
  const phone = await browser.newContext({ storageState: undefined });
  const r = await phone.newPage();
  await r.goto(url);
  await expect(r.getByRole('alert')).toContainText(/fue anulado|was withdrawn/);
  await shot(r, 'v2-respondent-link-revoked');
  await phone.close();
});
