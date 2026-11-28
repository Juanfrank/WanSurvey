import { expect, test } from './fixtures.js';
import { expectAccessible, login, pickOrganisation, shot, gotoTab } from './helpers.js';

/** A 1×1 PNG, scaled up by the page. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('a project logo, and the web survey in the project colours with it', async ({
  page,
  browser,
}) => {
  await login(page);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await gotoTab(page, 'Project settings');
  await page.getByRole('tab', { name: 'Logo and style', exact: true }).click();

  await page.getByLabel('Choose the logo image').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByText('Logo saved.')).toBeVisible();
  // The project header shows it at once.
  await expect(page.getByTestId('project-logo').first()).toBeVisible();

  // A main colour whose shades respondents could not read is not saved.
  await page.getByLabel('Main colour').fill('#ffd400');
  await expect(page.getByTestId('look-problems').getByRole('listitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save style' }).click();
  await expect(page.getByText(/^The style was not saved/)).toBeVisible();
  await expect(page.getByText('Style saved.')).toHaveCount(0);

  await page.getByLabel('Main colour').fill('#7a1f5c');
  await expect(page.getByTestId('look-problems')).toHaveCount(0);
  await page.getByLabel('Logo description').fill('Instituto Demo de Estadística');
  await page.getByRole('combobox', { name: 'Corners' }).selectOption({ label: 'Very round' });
  await page
    .getByRole('combobox', { name: 'Logo', exact: true })
    .selectOption({ label: 'Centred above' });
  const preview = page.getByTestId('look-preview');
  await expect(preview.getByText('Next', { exact: true })).toHaveCSS(
    'background-color',
    'rgb(122, 31, 92)',
  );
  await page.getByRole('button', { name: 'Save style' }).click();
  await expect(page.getByText('Style saved.')).toBeVisible();
  await shot(page, 'settings-look');
  await expectAccessible(page);

  // A respondent opens the web survey: the logo and the colours are there.
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
  const respondent = await (await browser.newContext()).newPage();
  await respondent.goto(`/o/${l.slug}`);
  const shell = respondent.getByTestId('respondent-shell');
  await expect(shell.getByRole('img', { name: 'Instituto Demo de Estadística' })).toBeVisible();
  // The page opens with the introduction: focus starts there, so it is read before the question.
  await expect(respondent.locator('[data-qkey^="A0_CONSENT_TEXT"]')).toBeFocused();
  await expect(respondent.getByRole('button', { name: /^Siguiente/ })).toHaveCSS(
    'background-color',
    'rgb(122, 31, 92)',
  );
  await shot(respondent, 'respondent-branded', { fullPage: false });

  // Back as it was for the other tests.
  await page.request.put(`/api/v1/projects/${projectId}/open-link`, {
    headers: { 'x-csrf-token': csrf },
    data: { active: false },
  });
  await page.getByRole('button', { name: 'Back to the default style' }).click();
  await page.getByLabel('Logo description').fill('');
  await page.getByRole('button', { name: 'Save style' }).click();
  await expect(page.getByText('Style saved.')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Remove logo' }).click();
  await expect(page.getByText('Logo removed.')).toBeVisible();
});
