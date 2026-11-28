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
  // Where the interview sits: the project, the interviewer's cases and the case (64).
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs).toContainText('Household Survey 2026');
  await expect(crumbs.getByRole('link', { name: 'My cases' })).toBeVisible();
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText(caseId);
  await shot(page, 'v2-interview-breadcrumb', { fullPage: false });
  // A note before stopping: the card shown when it is taken up again repeats it (176).
  await page.keyboard.press('Control+m');
  const noteDialog = page.getByRole('dialog', { name: /^Note on / });
  await noteDialog.getByLabel('Note').fill('Call back after 5 pm, the respondent is at work');
  await noteDialog.getByRole('button', { name: 'Add note' }).click();
  await expect(noteDialog).toBeHidden();
  await onQuestion(page, 'A3');

  // Reload: same question, same answers.
  await page.reload();
  await onQuestion(page, 'A3');
  await expect(page.getByTestId('answers-so-far')).toContainText('40');
  // Taken up again: where it stopped; the region from the sample is still to be confirmed.
  await expect(page.getByTestId('resume-card')).toContainText('You stopped at');
  await expect(page.getByTestId('prefilled-answers')).toContainText('E5_REGION');
  await expect(page.getByTestId('resume-note')).toContainText('Call back after 5 pm');
  await shot(page, 'interview-resumed');
  await shot(page, 'v2-interview-resume-note', { fullPage: false });
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
  // On a phone with a touch screen, Back and Next stay at the bottom, under the thumb (171).
  // (Same browser, so the same device: a touch screen emulated on a page of its own.)
  const thumb = await context.newPage();
  await thumb.setViewportSize({ width: 390, height: 844 });
  const cdp = await context.newCDPSession(thumb);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await thumb.goto(page.url());
  await expect(thumb.getByTestId('runner')).toBeVisible();
  await expect.poll(() => thumb.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  await thumb.getByTestId('resume-card').getByRole('button', { name: 'Continue here' }).click();
  const bar = thumb.getByTestId('runner-nav');
  await expect(bar).toHaveCSS('position', 'sticky');
  await expect(bar.getByRole('button', { name: /^Next/ })).toBeInViewport();
  await shot(thumb, 'v2-interview-phone-thumb-nav', { fullPage: false });
  await thumb.close();
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
  // The disposition by its name, not its code.
  await expect(page.getByText('The interview has ended (refusal).')).toBeVisible();
  await shot(page, 'v2-interview-end-disposition', { fullPage: false });
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
