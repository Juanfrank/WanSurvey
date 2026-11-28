import { expect, test, type Page } from './fixtures.js';
import { connectDb } from './db.js';
import { PM, expectAccessible, login, shot, pickOrganisation, gotoTab } from './helpers.js';

const INTERVIEWER = 'interviewer@demo.wansurvey.test';
const GOAL_ID = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

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
  await gotoTab(page, 'Project settings');
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
  const db = connectDb();
  try {
    await openProject(page, INTERVIEWER);
    await page.getByRole('tab', { name: 'Phone calls' }).click();
    const calls = page.getByTestId('calls');
    await expect(calls.getByRole('button', { name: /Next case/ })).toBeVisible();
    // Before asking, what the queue would bring: a preview that takes nothing (19).
    await expect(calls.getByTestId('queue-peek')).toContainText(/^Next: /);

    // N: the next case, with its numbers, introduction and outcomes.
    await page.keyboard.press('n');
    const form = calls.locator('form[data-case]');
    await expect(form).toBeVisible();
    const caseId = (await form.getAttribute('data-case'))!;
    await expect(form.getByTestId('script')).toContainText('Buenos días');
    await expect(form.getByTestId('call-timer')).toBeVisible();
    // The save button says why it waits; 0 chooses the tenth outcome.
    await expect(form.locator('#save-why')).toHaveText('Choose what happened.');
    await page.keyboard.press('0');
    await expect(form.getByRole('radio', { name: /Do not contact again/ })).toBeChecked();
    await expect(form.locator('#save-why')).toHaveText('');
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
    // Hours open all day read as no restriction; the time is confirmed in words.
    await expect(picker).toContainText('No calling-hour restriction.');
    await expect(picker.getByTestId('callback-when')).toContainText(
      /respondent’s time \(in (1 hour|\d+ minutes)\)/,
    );
    await shot(page, 'cati-callback');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('calls-message')).toContainText('Saved: Call back later');
    // With no case open, the caller's day so far.
    await expect(page.getByTestId('shift-summary')).toContainText('Calls');
    const mine = page.getByTestId('callbacks').locator('li').filter({ hasText: caseId });
    await expect(mine).toContainText('For me');
    await expect(mine).toContainText('Booked by');

    // Time passes: the callback is due, announced, listed as due now, and called from the list.
    await db.run(
      `update cases set next_contact_at = dateadd(minute, -1, sysdatetimeoffset()) where external_id = ?`,
      [caseId],
    );
    // A goal for this caller this week (taken off at the end: other tests set their own).
    await db.run(
      `insert into interviewer_goals (id, tenant_id, project_id, user_id, frequency, starts_on, ends_on, target)
       select ?, p.tenant_id, p.id, u.id, 'period', cast(dateadd(day, -1, sysdatetimeoffset()) as date),
              cast(dateadd(day, 6, sysdatetimeoffset()) as date), 10
       from projects p cross join users u
       where p.name = 'Household Survey 2026' and u.email = ?`,
      [GOAL_ID, INTERVIEWER],
    );
    await page.reload();
    await page.getByRole('tab', { name: 'Phone calls' }).click();
    await expect(page.getByTestId('callback-due')).toContainText(`Callback due: case ${caseId}`);
    // The empty screen says what comes next, and the caller's goal sits with the day so far.
    await expect(page.getByTestId('queue-peek')).toHaveAttribute('data-kind', 'callback');
    await expect(page.getByTestId('queue-peek')).toContainText('Next: an overdue callback from');
    await expect(page.getByTestId('shift-goal')).toContainText('My goal: ');
    await shot(page, 'v2-cati-peek-and-goal', { fullPage: false });
    await expect(page.getByTestId('callbacks-overdue')).toContainText(caseId);
    // Folded by default: a floating "Callbacks (1)" button, so the call area keeps the width.
    const callbacksBox = page.getByRole('complementary', { name: 'My callbacks' });
    const floating = callbacksBox.getByRole('button', { name: 'Callbacks (1)', exact: true });
    await expect(floating).toHaveAttribute('aria-expanded', 'false');
    await shot(page, 'cati-callbacks');
    await expectAccessible(page);
    await shot(page, 'cati-callbacks-rail', { fullPage: false });
    // It opens over the call area, below the button (in the title row, it covers nothing).
    await floating.click();
    await expect(floating).toHaveAttribute('aria-expanded', 'true');
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
    const [row] = await db.all(`select status, disposition from cases where external_id = ?`, [
      caseId,
    ]);
    expect(row).toMatchObject({ status: 'finalised', disposition: 'REFUSAL' });
    await page.getByRole('tab', { name: 'My cases' }).click();
    await page.getByLabel('Search id or sample data').fill(caseId);
    await page.getByRole('button', { name: `Open case ${caseId}` }).click();
    const drawer = page.getByRole('dialog', { name: `Case ${caseId}` });
    const history = drawer.getByTestId('case-calls');
    await expect(history).toContainText('Answered');
    await expect(history).toContainText('Call back later');
  } finally {
    await db.run(`delete from interviewer_goals where id = ?`, [GOAL_ID]);
    await db.end();
  }
});

test('a supervisor sees the attempts used against the limit; whoever runs the project reopens an exhausted case', async ({
  page,
  browser,
}) => {
  const db = connectDb();
  // A held case of the project, closed here as a non-contact after its last allowed attempt.
  const [c] = await db.all(
    `select top 1 c.id, c.external_id, c.status, c.disposition, c.attempts, p.settings
     from cases c join projects p on p.id = c.project_id
     where p.name = 'Household Survey 2026' and c.status = 'assigned'
       and c.checked_out_device is null and c.assigned_to is not null
     order by c.external_id desc`,
  );
  const max =
    (JSON.parse((c!.settings as string | null) ?? '{}') as { cati?: { maxAttempts?: number } }).cati
      ?.maxAttempts ?? 8;
  const id = c!.external_id as string;
  try {
    await db.run(
      `update cases set status = 'finalised', disposition = 'NON_CONTACT', attempts = ? where id = ?`,
      [max, c!.id],
    );
    const openCase = async (p: Page, email: string) => {
      await openProject(p, email);
      await p.getByRole('tab', { name: 'Cases', exact: true }).click();
      await p.getByLabel('Search id or sample data').fill(id);
      await p.getByRole('button', { name: `Open case ${id}`, exact: true }).click();
      const d = p.getByRole('dialog', { name: `Case ${id}` });
      await expect(d.getByTestId('case-attempts')).toHaveText(`${max} attempts of ${max} allowed`);
      return d;
    };
    // The supervisor sees the limit reached, but reopening is not theirs to do.
    const other = await browser.newContext();
    try {
      const supPage = await other.newPage();
      const supDrawer = await openCase(supPage, 'supervisor@demo.wansurvey.test');
      await expect(supDrawer.getByRole('button', { name: /^Reopen with/ })).toHaveCount(0);
    } finally {
      await other.close();
    }
    const drawer = await openCase(page, PM);
    const reopen = drawer.getByRole('button', { name: `Reopen with ${max} new attempts` });
    await expect(reopen).toBeVisible();
    await shot(page, 'v2-cati-exhausted-case', { fullPage: false });
    page.once('dialog', (d) => void d.accept());
    await reopen.click();
    await expect(drawer).toContainText(`Case reopened with ${max} new attempts.`);
    await expect(drawer.getByTestId('case-header')).toContainText('Assigned');
    await expect(reopen).toHaveCount(0);
    await shot(page, 'v2-cati-case-reopened', { fullPage: false });
    const [after] = await db.all(`select status, disposition, attempts from cases where id = ?`, [
      c!.id,
    ]);
    expect(after).toMatchObject({ status: 'assigned', disposition: null, attempts: 0 });
  } finally {
    await db.run(`update cases set status = ?, disposition = ?, attempts = ? where id = ?`, [
      c!.status,
      c!.disposition,
      c!.attempts,
      c!.id,
    ]);
    await db.end();
  }
});
