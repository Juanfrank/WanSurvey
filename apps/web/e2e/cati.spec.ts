import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { PM, expectAccessible, login, shot, pickOrganisation } from './helpers.js';

const INTERVIEWER = 'interviewer@demo.wansurvey.test';
const adminUrl =
  process.env.E2E_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/wansurvey_e2e';

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

test('the project manager opens calling hours all day', async ({ page }) => {
  await openProject(page, PM);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Phone', exact: true }).click();
  const cati = page.getByTestId('cati-settings');
  await cati.getByLabel('Calling from').fill('00:00');
  await cati.getByLabel('Calling until').fill('00:00');
  await cati.getByLabel('Attempts per case').fill('6');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
});

test('a telephone shift by keyboard: callback, callback served first, answered interview', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await openProject(page, INTERVIEWER);
    await page.getByRole('tab', { name: 'Phone calls' }).click();
    const calls = page.getByTestId('calls');
    await expect(calls.getByRole('button', { name: /Next case/ })).toBeVisible();

    // N: the next case, with its numbers, introduction and outcomes.
    await page.keyboard.press('n');
    const form = calls.locator('form[data-case]');
    await expect(form).toBeVisible();
    const caseId = (await form.getAttribute('data-case'))!;
    await expect(form.getByTestId('script')).toContainText('Buenos días');
    await expect(form.getByTestId('call-timer')).toBeVisible();
    await page.keyboard.press('Alt+1');
    await expect(form.getByRole('radio', { checked: true }).first()).toBeVisible();
    await shot(page, 'cati-workspace');
    await expectAccessible(page);

    // 8: call back later, in an hour, for me; Ctrl+Enter saves.
    await page.keyboard.press('8');
    await expect(form.getByRole('radio', { name: /Call back later/ })).toBeChecked();
    await expect(form.getByTestId('script').last()).toContainText('volver a llamarle');
    const picker = form.getByTestId('callback-picker');
    await picker.getByRole('button', { name: 'In 1 hour' }).click();
    await expect(picker.getByRole('radio', { name: 'Me' })).toBeChecked();
    await expect(picker).toContainText('Calling hours: 00:00–00:00');
    await shot(page, 'cati-callback');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('calls-message')).toContainText('Saved: Call back later');
    const mine = page.getByTestId('callbacks').locator('li').filter({ hasText: caseId });
    await expect(mine).toContainText('For me');
    await expect(mine).toContainText('Booked by');

    // Time passes: the callback is due, announced, listed as due now, and called from the list.
    await sql`update cases set next_contact_at = now() - interval '1 minute' where external_id = ${caseId}`;
    await page.reload();
    await page.getByRole('tab', { name: 'Phone calls' }).click();
    await expect(page.getByTestId('callback-due')).toContainText(`Callback due: case ${caseId}`);
    await expect(page.getByTestId('callbacks-overdue')).toContainText(caseId);
    await shot(page, 'cati-callbacks');
    await expectAccessible(page);
    // Collapsed, a rail beside the calls counts what is due; it opens over the call area.
    await page.getByRole('button', { name: 'Unpin: My callbacks' }).click();
    const rail = page.getByRole('complementary', { name: 'My callbacks' });
    await expect(rail).toContainText('1');
    // The pointer was on the pin, now over the rail: move it away to see the rail alone.
    await page.mouse.move(500, 500);
    await expect(rail.getByRole('button', { name: 'My callbacks', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await shot(page, 'cati-callbacks-rail', { fullPage: false });
    await rail.getByRole('button', { name: 'My callbacks', exact: true }).click();
    await shot(page, 'cati-callbacks-over', { fullPage: false });
    await page.getByRole('button', { name: `Call now: case ${caseId}` }).click();
    await expect(calls.locator('form[data-case]')).toHaveAttribute('data-case', caseId);

    // 1: answered — the telephone interview opens; consent No ends it.
    await page.keyboard.press('1');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByRole('heading', { name: new RegExp(`Case ${caseId}`) })).toBeVisible();
    await expect(page.getByTestId('script').first()).toContainText('Buenos días');
    await onQuestion(page, 'A0_CONSENT_TEXT');
    await page.keyboard.press('Enter');
    await onQuestion(page, 'A1');
    await page.keyboard.type('2');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved', {
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Submit interview' }).click();
    await expect(page.getByTestId('calls-message')).toContainText('Interview submitted');

    // The case shows both calls.
    const [row] = await sql`select status, disposition from cases where external_id = ${caseId}`;
    expect(row).toMatchObject({ status: 'finalised', disposition: 'REFUSAL' });
    await page.getByRole('tab', { name: 'My cases' }).click();
    await page.getByLabel('Search id or sample data').fill(caseId);
    await page.getByRole('button', { name: `Open case ${caseId}` }).click();
    const drawer = page.getByRole('dialog', { name: `Case ${caseId}` });
    const history = drawer.getByTestId('case-calls');
    await expect(history).toContainText('Answered');
    await expect(history).toContainText('Call back later');
  } finally {
    await sql.end();
  }
});
