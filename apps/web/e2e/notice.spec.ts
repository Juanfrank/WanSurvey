import { expect, test } from '@playwright/test';
import { expectAccessible, login, pickOrganisation, shot } from './helpers.js';

const NOTICE =
  'Somos el Instituto Demo. Participar es voluntario y sus datos se usan solo para esta encuesta.';

test('the information notice is written in the settings and asked before the first question', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await login(page);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Privacy', exact: true }).click();

  // With no retention period the screen says so.
  const days = page.getByRole('spinbutton', { name: /Remove personal data this many days/ });
  await days.fill('');
  await expect(page.getByText(/No period is set/)).toBeVisible();
  await shot(page, 'settings-privacy-warning', { fullPage: true });
  await days.fill('365');
  await expect(page.getByText(/No period is set/)).toHaveCount(0);

  await page.getByLabel('Notice text').fill(NOTICE);
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible();
  await shot(page, 'settings-notice');
  await expectAccessible(page);

  // A web respondent: the notice first, then the questions.
  const csrf = (await page.context().cookies()).find((c) => c.name === 'ws_csrf')!.value;
  const projectId = new URL(page.url()).pathname.split('/')[2]!;
  const qs = (await (
    await page.request.get(`/api/v1/projects/${projectId}/questionnaires`)
  ).json()) as { id: string; name: string }[];
  const qid = qs.find((q) => q.name === 'Household questionnaire')!.id;
  const link = await page.request.put(`/api/v1/projects/${projectId}/open-link`, {
    headers: { 'x-csrf-token': csrf },
    data: { active: true, questionnaireId: qid },
  });
  const { link: l } = (await link.json()) as { link: { slug: string } };

  const declined = await (await browser.newContext()).newPage();
  await declined.goto(`/o/${l.slug}`);
  await expect(declined.getByTestId('notice')).toContainText('Participar es voluntario');
  await expect(declined.getByRole('button', { name: /^Siguiente/ })).toHaveCount(0);
  await declined.getByRole('button', { name: 'No deseo participar' }).click();
  await expect(declined.getByTestId('notice-declined')).toBeVisible();
  await expect(declined.getByRole('button', { name: /^Siguiente/ })).toHaveCount(0);

  const respondent = await (await browser.newContext()).newPage();
  await respondent.goto(`/o/${l.slug}`);
  await expect(respondent.getByTestId('notice')).toBeVisible();
  await shot(respondent, 'respondent-notice', { fullPage: false });
  await expectAccessible(respondent);
  await respondent.getByRole('button', { name: 'Entiendo y quiero participar' }).click();
  await expect(respondent.getByTestId('notice')).toHaveCount(0);
  await expect(respondent.locator('[data-qkey]').first()).toBeVisible();
  // Coming back, it is not asked again.
  await respondent.reload();
  await expect(respondent.getByTestId('notice')).toHaveCount(0);
  await expect(respondent.locator('[data-qkey]').first()).toBeVisible();

  // Back as it was for the other tests.
  await page.request.put(`/api/v1/projects/${projectId}/open-link`, {
    headers: { 'x-csrf-token': csrf },
    data: { active: false },
  });
  await page.getByLabel('Notice text').fill('');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible();
});

test('an interviewer reads the notice before the first question of a face-to-face interview', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  // The project manager writes the notice.
  await login(page);
  await pickOrganisation(page, 'Demo Research');
  const csrf = (await page.context().cookies()).find((c) => c.name === 'ws_csrf')!.value;
  const projects = (await (await page.request.get('/api/v1/projects')).json()) as {
    id: string;
    name: string;
  }[];
  const projectId = projects.find((p) => p.name === 'Household Survey 2026')!.id;
  const setNotice = (text: string) =>
    page.request.patch(`/api/v1/projects/${projectId}`, {
      headers: { 'x-csrf-token': csrf },
      data: { settings: { notice: { text, version: 1 } } },
    });
  expect((await setNotice(NOTICE)).ok()).toBe(true);

  const staff = await (await browser.newContext()).newPage();
  await login(staff, 'interviewer@demo.wansurvey.test');
  await pickOrganisation(staff, 'Demo Research');
  await staff
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await staff.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await staff.getByRole('tab', { name: 'My cases' }).click();
  await staff.getByRole('combobox', { name: /^Status/ }).selectOption('assigned');
  const row = staff.getByTestId('cases-table').locator('tbody tr').first();
  await expect(row).toContainText('Assigned');
  const caseId = (await row.getAttribute('data-case'))!;
  await row.getByRole('button', { name: `Open case ${caseId}` }).click();
  const drawer = staff.getByRole('dialog', { name: `Case ${caseId}` });
  await drawer.getByRole('button', { name: 'Start interview' }).click();
  await drawer.getByLabel('Mode').selectOption('CAPI');
  await drawer.getByRole('button', { name: 'Start interview' }).click();

  const dialog = staff.getByTestId('info-notice');
  await expect(dialog).toContainText('Participar es voluntario');
  await shot(staff, 'interview-notice', { fullPage: false });
  await expectAccessible(staff);
  await staff.getByRole('button', { name: 'They understand and agree to continue' }).click();
  await expect(staff.getByTestId('info-notice')).toHaveCount(0);
  await expect(staff.locator('[data-qkey]').first()).toBeVisible();

  await setNotice('');
});
