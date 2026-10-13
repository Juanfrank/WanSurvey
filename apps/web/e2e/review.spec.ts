import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, login, shot, pickOrganisation } from './helpers.js';

const INTERVIEWER = 'interviewer@demo.wansurvey.test';
const SUPERVISOR = 'supervisor@demo.wansurvey.test';

async function openProject(page: Page, email: string) {
  await login(page, email);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByRole('link', { name: 'Household Survey 2026' }).click();
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
  await iv.getByRole('combobox', { name: /^Status/ }).selectOption('assigned');
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
  await sup.getByRole('tab', { name: 'Review' }).click();
  const queued = sup.getByTestId('review-queue').locator(`tr[data-case="${caseId}"]`);
  await expect(queued).toBeVisible();
  await shot(sup, 'review-queue');
  await expectAccessible(sup);
  await queued.getByRole('button', { name: `Review ${caseId}` }).click();
  const screen = sup.getByTestId('review-screen');
  await expect(screen.locator('[data-qkey="A2_AGE"] [data-testid="answer"]')).toHaveText('15');
  await screen.getByRole('button', { name: 'Comment A2_AGE' }).click();
  await sup.getByLabel('Comment', { exact: true }).fill('La cédula dice 16 años.');
  await sup.getByRole('button', { name: 'Send' }).click();
  await expect(screen.locator('[data-qkey="A2_AGE"]').getByTestId('comments')).toContainText(
    '16 años',
  );
  await sup.keyboard.press('r');
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
  await shot(iv, 'returned-to-me');
  await returned.getByRole('button', { name: `Fix ${caseId}` }).click();
  await expect(iv.getByTestId('returned-comments')).toContainText('16 años');
  await iv.getByTestId('section-nav').getByRole('button').first().click();
  await onQuestion(iv, 'A0_CONSENT_TEXT');
  await iv.keyboard.press('Enter');
  await onQuestion(iv, 'A1');
  await iv.keyboard.press('Enter');
  await onQuestion(iv, 'A2');
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
  await sup.keyboard.press('a');
  await expect(sup.getByTestId('review-status')).toHaveAttribute('data-status', 'approved');
});
