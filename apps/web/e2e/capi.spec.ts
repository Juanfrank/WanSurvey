import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { expectAccessible, login, shot, pickOrganisation } from './helpers.js';

const INTERVIEWER = 'interviewer@demo.wansurvey.test';
const adminUrl =
  process.env.E2E_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/wansurvey_e2e';

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

test('download cases, interview offline after a reload, and everything arrives once online', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await login(page, INTERVIEWER);
    await pickOrganisation(page, 'Demo Research');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Projects', exact: true })
      .click();
    await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
    await page.getByRole('link', { name: 'My device (offline)' }).click();
    await expect(page.getByRole('heading', { name: 'My device' })).toBeVisible();

    // Download the last three of my cases.
    const boxes = page.getByTestId('download-list').getByRole('checkbox');
    await expect(boxes.first()).toBeVisible();
    const n = await boxes.count();
    for (let i = n - 3; i < n; i++) await boxes.nth(i).check();
    await page.getByRole('button', { name: 'Download selected' }).click();
    await expect(page.getByTestId('device-message')).toContainText('3 cases downloaded.');
    const rows = page.getByTestId('device-cases').locator('tbody tr');
    await expect(rows).toHaveCount(3);
    const ids = await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-case')!));

    // The app shell is cached; with no connection a reload still opens the device page.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'My device' })).toBeVisible();
    await expect(page.getByTestId('connection')).toHaveText('Offline');
    await expect(rows).toHaveCount(3);
    await shot(page, 'device-offline');
    await expectAccessible(page);

    // Three interviews with no connection: consent refused ends each one.
    for (const id of ids) {
      await page.getByRole('button', { name: `Start interview ${id}` }).click();
      await expect(page.getByRole('heading', { name: new RegExp(`Case ${id}`) })).toBeVisible();
      await expect(page.getByText('Device copy')).toBeVisible();
      await onQuestion(page, 'A0_CONSENT_TEXT');
      await page.keyboard.press('Enter');
      await onQuestion(page, 'A1');
      await page.keyboard.type('2');
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Submit interview' }).click();
      await expect(page.getByTestId('device-message')).toContainText('kept on this device');
      await expect(page.locator(`tr[data-case="${id}"]`)).toHaveAttribute('data-status', 'queued');
    }
    await expect(page.getByTestId('waiting')).toContainText('3 interviews waiting to be sent');

    // Back online: sent, submitted and returned without doing anything.
    await context.setOffline(false);
    await expect(page.getByTestId('connection')).toHaveText('Online');
    await expect(page.getByTestId('device-message')).toContainText(
      'Synced: 3 interviews sent, 3 cases returned.',
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('waiting')).toHaveText('Everything has been sent.');
    const done =
      await sql`select external_id, status, disposition, checked_out_device from cases where external_id in ${sql(ids)}`;
    expect(done).toHaveLength(3);
    for (const c of done)
      expect(c).toMatchObject({
        status: 'finalised',
        disposition: 'REFUSAL',
        checked_out_device: null,
      });
    const offline =
      await sql`select count(*)::int as n from case_events e join cases c on c.id = e.case_id
                where c.external_id in ${sql(ids)} and e.type = 'interview_started' and (e.details->>'offline')::boolean`;
    expect(offline[0]!.n).toBe(3);
  } finally {
    await sql.end();
  }
});
