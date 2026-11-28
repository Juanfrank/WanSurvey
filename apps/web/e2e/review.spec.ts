import { expect, overlaysSettled, test, type Page } from './fixtures.js';
import {
  expectAccessible,
  login,
  shot,
  pickOrganisation,
  openFilters,
  closeFilters,
} from './helpers.js';

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

const question = (page: Page, id: string) => page.locator(`[data-qkey^="${id}"]`).first();
async function onQuestion(page: Page, id: string) {
  const q = question(page, id);
  await expect(q).toBeVisible();
  await expect
    .poll(() =>
      q.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)),
    )
    .toBe(true);
}
async function submit(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved', {
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'Submit interview' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
}

test('a reviewer returns an interview with a comment, the interviewer fixes it, and it is approved', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  // The interviewer interviews a case: consent yes, age 15 (screened out).
  const iv = await (await browser.newContext({ storageState: './e2e/english-ui.json' })).newPage();
  await openProject(iv, INTERVIEWER);
  await iv.getByRole('tab', { name: 'My cases' }).click();
  await openFilters(iv);
  await iv.getByRole('combobox', { name: /^Status/ }).selectOption('assigned');
  await closeFilters(iv);
  const row = iv.getByTestId('cases-table').locator('tbody tr').first();
  await expect(row).toContainText('Assigned');
  const caseId = (await row.getAttribute('data-case'))!;
  await row.getByRole('button', { name: `Open case ${caseId}` }).click();
  const drawer = iv.getByRole('dialog', { name: `Case ${caseId}` });
  await drawer.getByRole('button', { name: 'Start interview' }).click();
  await drawer.getByLabel('Mode').selectOption('CAPI');
  await drawer.getByRole('button', { name: 'Start interview' }).click();
  await onQuestion(iv, 'A0_CONSENT_TEXT');
  await iv.keyboard.press('Enter');
  await onQuestion(iv, 'A1');
  await iv.keyboard.type('1');
  await iv.keyboard.press('Enter');
  await onQuestion(iv, 'A2');
  await iv.keyboard.type('15');
  await iv.keyboard.press('Enter');
  await submit(iv);

  // The supervisor finds it in the queue, opens it and returns it with a comment.
  const sup = await (await browser.newContext({ storageState: './e2e/english-ui.json' })).newPage();
  await openProject(sup, SUPERVISOR);
  await sup.getByRole('tab', { name: 'Supervision', exact: true }).click();
  const queued = sup.getByTestId('review-queue').locator(`tr[data-case="${caseId}"]`);
  await expect(queued).toBeVisible();
  // The queue by interviewer, in the Filters panel: each person with their count of
  // interviews; choosing one keeps their interviews only.
  await openFilters(sup);
  const people = sup.getByRole('combobox', { name: 'Interviewer' });
  const demo = people.locator('option', { hasText: /^Demo interviewer · \d+ interviews?/ });
  await people.selectOption((await demo.getAttribute('value'))!);
  await closeFilters(sup);
  await expect(queued).toBeVisible();
  await expect(
    sup.getByTestId('review-queue').locator('tbody tr').filter({ hasNotText: 'Demo interviewer' }),
  ).toHaveCount(0);
  // The person chosen is also a filter that is on, with its chip.
  await expect(
    sup.getByRole('button', { name: 'Remove filter: Interviewer Demo interviewer' }),
  ).toBeVisible();
  await shot(sup, 'review-queue');
  await sup.getByRole('button', { name: 'Remove filter: Interviewer Demo interviewer' }).click();
  // The search finds a case by part of its id (asked of the server, not of the rows shown).
  const search = sup.getByRole('searchbox', { name: 'Search by case' });
  await search.fill(caseId.slice(1));
  await expect(queued).toBeVisible();
  const queueRows = sup.getByTestId('review-queue').locator('tbody tr');
  await expect
    .poll(async () =>
      (await queueRows.evaluateAll((rs) => rs.map((r) => r.getAttribute('data-case') ?? ''))).every(
        (c) => c.includes(caseId.slice(1)),
      ),
    )
    .toBe(true);
  await search.fill('');
  await expect(queueRows).toHaveCount(20);
  // Every filter waits in the Filters panel, the Status too: it gets a chip only when it is
  // not the queue's own ("Waiting for review").
  await expect(sup.getByRole('button', { name: /^Remove filter: Status/ })).toHaveCount(0);
  await openFilters(sup);
  const status = sup.getByRole('combobox', { name: 'Status' });
  await status.selectOption('approved');
  await expect(sup.getByRole('button', { name: 'Remove filter: Status Approved' })).toBeVisible();
  await expect(queued).toHaveCount(0);
  await status.selectOption('submitted,in_review');
  await expect(sup.getByRole('button', { name: /^Remove filter: Status/ })).toHaveCount(0);
  await sup.getByRole('combobox', { name: 'Flag' }).selectOption('speeding');
  await expect(sup.getByRole('button', { name: 'Filters · 1' })).toBeVisible();
  await shot(sup, 'p2-review-queue-filters', { fullPage: false });
  await expectAccessible(sup);
  await sup.getByRole('combobox', { name: 'Flag' }).selectOption('');
  await closeFilters(sup);
  await expect(queued).toBeVisible();
  // The queue shows 20 interviews at a time.
  await expect(queueRows).toHaveCount(20);
  await sup.getByRole('button', { name: /^Show \d+ more \(\d+ left\)$/ }).click();
  await expect.poll(() => queueRows.count()).toBeGreaterThan(20);
  await expectAccessible(sup);
  // The coding of "other" answers has its own tab beside the queue.
  const sections = sup.getByRole('tablist', { name: 'Supervision sections' });
  await sections.getByRole('tab', { name: /^“Other” coding/ }).click();
  await expect(sup.getByRole('heading', { name: 'Coding of “other” answers' })).toBeVisible();
  await shot(sup, 'p2-review-coding');
  await expectAccessible(sup);
  await sections.getByRole('tab', { name: 'Review queue', exact: true }).click();
  await queued.getByRole('button', { name: `Review ${caseId}` }).click();
  const screen = sup.getByTestId('review-screen');
  await expect(screen.locator('[data-qkey="A2_AGE"] [data-testid="answer"]')).toHaveText('15');
  // Where the interview sits: Projects / the project / Supervision / the case.
  const crumbs = sup.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs.getByRole('link', { name: 'Household Survey 2026' })).toBeVisible();
  await expect(crumbs.getByRole('link', { name: 'Supervision' })).toBeVisible();
  await expect(crumbs.getByRole('heading', { level: 1 })).toHaveText(`Review · case ${caseId}`);
  await shot(sup, 'v2-review-breadcrumbs', { fullPage: false });
  await screen.getByRole('button', { name: 'Comment A2_AGE' }).click();
  await overlaysSettled(sup, 1);
  await sup.getByLabel('Comment', { exact: true }).fill('La cédula dice 16 años.');
  await sup.getByRole('button', { name: 'Send' }).click();
  await expect(screen.locator('[data-qkey="A2_AGE"]').getByTestId('comments')).toContainText(
    '16 años',
  );
  // Only the questions with something to look at (here the commented, twice-typed age).
  await expect(screen.getByTestId('issue-count')).toHaveText(
    '1 question with warnings, notes, comments or changes',
  );
  await screen.getByLabel('Show only those').check();
  await expect(screen.locator('[data-qkey="A1_CONSENT"]')).toBeHidden();
  await expect(screen.locator('[data-qkey="A2_AGE"]')).toBeVisible();
  await screen.getByLabel('Show only those').uncheck();
  // The A/R keys are not taken from a form field: leave the checkbox first.
  await sup.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await sup.keyboard.press('r');
  await overlaysSettled(sup, 2);
  await sup.getByLabel('Comment', { exact: true }).fill('Corrija la edad, por favor.');
  await sup.getByRole('button', { name: 'Confirm' }).click();
  await expect(sup.getByTestId('review-status')).toHaveAttribute('data-status', 'returned');
  await shot(sup, 'review-screen');
  await expectAccessible(sup);

  // The interviewer sees it under "Returned to me", fixes the age and resubmits.
  await iv.reload();
  await iv.getByRole('tab', { name: 'My cases' }).click();
  const returned = iv.getByTestId('returned');
  await expect(returned).toContainText('Corrija la edad');
  // The commented question is listed with its comment, and the interviewer's own signals show.
  await expect(returned.getByTestId('returned-questions')).toContainText(
    'A2_AGE La cédula dice 16 años.',
  );
  await expect(iv.getByTestId('my-quality')).toBeVisible();
  // Their cases come in blocks of 20.
  await expect(iv.getByTestId('cases-table').locator('tbody tr').first()).toBeVisible();
  expect(await iv.getByTestId('cases-table').locator('tbody tr').count()).toBeLessThanOrEqual(20);
  await shot(iv, 'returned-to-me');
  await returned.getByRole('button', { name: `Fix ${caseId}` }).click();
  await expect(iv.getByTestId('returned-comments')).toContainText('16 años');
  // Straight to the commented question.
  await iv.getByTestId('returned-comments').getByRole('button', { name: 'Go to A2_AGE' }).click();
  await expect(question(iv, 'A2')).toBeVisible();
  await question(iv, 'A2').locator('input').first().fill('16');
  await question(iv, 'A2').locator('input').first().press('Enter');
  await submit(iv);

  // Second round: the history shows both answers; the supervisor approves with A.
  await sup.reload();
  await expect(sup.getByTestId('review-status')).toHaveAttribute('data-status', 'submitted');
  const age = sup.getByTestId('review-screen').locator('[data-qkey="A2_AGE"]');
  await expect(age.getByTestId('answer')).toHaveText('16');
  await age.getByText(/\d+ changes/).click();
  // Both rounds are there: the first answer (typed as 1, then 15) and the fix.
  await expect(age).toContainText('1 → 15');
  await expect(age).toContainText('15 → 16');
  // The reject and correct dialogs, looked at by axe while open and cancelled.
  await sup.getByRole('button', { name: 'Reject', exact: true }).click();
  await overlaysSettled(sup, 1);
  const reject = sup.getByRole('dialog', { name: 'Reject the interview' });
  await expect(reject).toBeVisible();
  await reject.getByRole('button', { name: 'Cancel' }).click();
  await expect(reject).toBeHidden();
  await age.getByRole('button', { name: /^Correct/ }).click();
  await overlaysSettled(sup, 2);
  const correct = sup.getByRole('dialog', { name: 'Correct A2_AGE' });
  await expect(correct).toBeVisible();
  await sup.keyboard.press('Escape');
  await expect(correct).toBeHidden();
  await sup.keyboard.press('a');
  await expect(sup.getByTestId('review-status')).toHaveAttribute('data-status', 'approved');

  // The interviewer's list shows the result of the finished case and its review.
  await iv.reload();
  await iv.getByRole('tab', { name: 'My cases' }).click();
  await iv.getByLabel('Search id or sample data').fill(caseId);
  const done = iv.locator(`tr[data-case="${caseId}"]`);
  await expect(done.locator('[data-review="approved"]')).toContainText('Review: approved');
  // The search has applied (it waits for a pause in typing): only ids that contain it are
  // listed (XHH0007, given to the interviewer by the case tests, also contains HH0007).
  await expect(iv.locator(`tr[data-case]:not([data-case*="${caseId}"])`)).toHaveCount(0);
  await shot(iv, 'v2-my-cases-review');
});
