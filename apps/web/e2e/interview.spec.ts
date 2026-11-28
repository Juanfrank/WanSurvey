import { expect, overlaysSettled, test, type Page } from './fixtures.js';
import { expectAccessible, login, shot, pickOrganisation } from './helpers.js';

const INTERVIEWER = 'interviewer@demo.wansurvey.test';
const SUPERVISOR = 'supervisor@demo.wansurvey.test';

async function openProject(page: Page, email: string) {
  await login(page, email);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
}

const saveStatus = (page: Page) => page.getByTestId('save-status');
/** Keys are variable names (A1_CONSENT…): match the item id they start with. */
const question = (page: Page, id: string) => page.locator(`[data-qkey^="${id}"]`).first();
/** The question is on screen and has keyboard focus (the runner moves it there after render). */
async function onQuestion(page: Page, id: string) {
  const q = question(page, id);
  await expect(q).toBeVisible();
  await expect
    .poll(() =>
      q.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)),
    )
    .toBe(true);
}

test('an interview autosaves, survives a reload and going offline, and submits', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await openProject(page, INTERVIEWER);
  await page.getByRole('tab', { name: 'My cases' }).click();
  await page.getByRole('combobox', { name: /^Status/ }).selectOption('assigned');
  const row = page.getByTestId('cases-table').locator('tbody tr').first();
  // Wait for the filtered list (earlier tests finish some of these cases).
  await expect(row).toContainText('Assigned');
  const caseId = (await row.getAttribute('data-case'))!;
  // Straight from the work list: the questionnaire has two modes, so the mode is asked first.
  await row.getByRole('button', { name: `Start case ${caseId}` }).click();
  const start = page.getByRole('dialog', { name: `Start an interview on case ${caseId}` });
  await start.getByLabel('Mode').selectOption('CAPI');
  await shot(page, 'v2-my-cases-start-dialog', { fullPage: false });
  await start.getByRole('button', { name: 'Start interview' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Case ${caseId}`) })).toBeVisible();

  // Consent text, consent yes, age 40: by keyboard.
  await onQuestion(page, 'A0_CONSENT_TEXT');
  await page.keyboard.press('Enter');
  await onQuestion(page, 'A1');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await onQuestion(page, 'A2');
  await page.keyboard.type('40');
  await page.keyboard.press('Enter');
  await onQuestion(page, 'A3');
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved', { timeout: 10_000 });
  await shot(page, 'interview-screen');
  await expectAccessible(page);

  // Reload: same question, same answers.
  await page.reload();
  await onQuestion(page, 'A3');
  await expect(page.getByTestId('answers-so-far')).toContainText('40');
  // Taken up again: where it stopped; the region from the sample is still to be confirmed.
  await expect(page.getByTestId('resume-card')).toContainText('You stopped at');
  await expect(page.getByTestId('prefilled-answers')).toContainText('E5_REGION');
  await shot(page, 'interview-resumed');
  // The same screen on a phone and a tablet: the question first, the actions at the bottom.
  for (const [name, size] of [
    ['interview-phone', { width: 390, height: 844 }],
    ['interview-tablet', { width: 820, height: 1180 }],
  ] as const) {
    const small = await context.newPage();
    await small.setViewportSize(size);
    await small.goto(page.url());
    await expect(small.getByTestId('runner')).toBeVisible();
    await expect(small.getByRole('complementary', { name: 'Case details' })).toBeHidden();
    await expect(small.getByTestId('interview-actions')).toBeInViewport();
    await shot(small, name, { fullPage: false });
    await small.close();
  }
  await page.getByTestId('resume-card').getByRole('button', { name: 'Continue here' }).click();
  await expect(page.getByTestId('resume-card')).toBeHidden();

  // In the dark theme the header and the action bar keep their contrast too.
  await page.evaluate(() => localStorage.setItem('ws.theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await onQuestion(page, 'A3');
  await expectAccessible(page);
  await shot(page, 'dark-interview', { fullPage: false });
  await page.evaluate(() => localStorage.setItem('ws.theme', 'light'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await onQuestion(page, 'A3');

  // Offline: the answer stays on the device, then reaches the server.
  await context.setOffline(true);
  await question(page, 'A3').getByRole('radio').first().check();
  await question(page, 'A3').getByRole('radio').first().press('Enter');
  await onQuestion(page, 'A4');
  await expect(saveStatus(page)).toHaveText('Saved on this device');
  await context.setOffline(false);
  await expect(saveStatus(page)).toHaveText('Saved', { timeout: 15_000 });

  // Shortcuts: help, pause.
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts')).toContainText('Ctrl+M');
  await overlaysSettled(page, 1);
  await page.getByRole('button', { name: 'Close' }).click();
  // The note dialog too: axe looks at it open, and Escape gives the focus back.
  await page.keyboard.press('Control+m');
  const note = page.getByRole('dialog', { name: /^Note on / });
  await overlaysSettled(page, 2);
  await expect(note).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(note).toBeHidden();
  await page.keyboard.press('Control+p');
  await expect(page.getByTestId('paused')).toBeVisible();
  await page.getByTestId('paused').getByRole('button', { name: 'Resume' }).click();

  // Back to consent and change it to No: later answers are cleared and the interview ends.
  await page.getByTestId('section-nav').getByRole('button').first().click();
  await onQuestion(page, 'A0_CONSENT_TEXT');
  await page.keyboard.press('Enter');
  await onQuestion(page, 'A1');
  await page.keyboard.type('2');
  await expect(page.getByText(/removed \d+ later answers/)).toBeVisible();
  await page.keyboard.press('Enter');
  // One end card: a summary, submit, and going back to review.
  await expect(page.getByTestId('end-summary')).toContainText('Duration');
  await expect(page.getByRole('button', { name: 'Go back to the last question' })).toBeVisible();
  await shot(page, 'interview-end');
  await page.getByRole('button', { name: 'Submit interview' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
  await page.getByRole('tab', { name: 'My cases' }).click();
  await page.getByLabel('Search id or sample data').fill(caseId);
  await expect(page.locator(`tr[data-case="${caseId}"]`)).toContainText('Finalised');

  // The supervisor sees the interview and every answer change.
  const sup = await context.browser()!.newPage();
  await openProject(sup, SUPERVISOR);
  await sup.getByRole('tab', { name: 'Cases' }).click();
  await sup.getByLabel('Search id or sample data').fill(caseId);
  await sup.getByRole('button', { name: `Open case ${caseId}` }).click();
  const d = sup.getByRole('dialog', { name: `Case ${caseId}` });
  const history = d.getByTestId('interviews');
  await expect(history).toContainText('Submitted · Refusal');
  await history.getByText(/Changes/).click();
  await expect(
    history.getByTestId('answer-history').locator('tr[data-reason="path_change"]').first(),
  ).toBeVisible();
  await shot(sup, 'interview-history');
  await expectAccessible(sup);
});
