import { expect, test, type Page } from './fixtures.js';
import { connectDb, marks } from './db.js';
import { expectAccessible, login, resultsSection, shot, pickOrganisation } from './helpers.js';

const INTERVIEWER = 'interviewer@demo.wansurvey.test';
const SUPERVISOR = 'supervisor@demo.wansurvey.test';

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
  const db = connectDb();
  try {
    await login(page, INTERVIEWER);
    await pickOrganisation(page, 'Demo Research');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Projects', exact: true })
      .click();
    await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
    // The way to the device page, with the connection and what waits to be sent beside it.
    const indicator = page.getByTestId('device-indicator');
    await expect(indicator).toHaveText(/^Online · 0 to send/);
    await page.getByRole('link', { name: 'My device', exact: true }).click();
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
    // Each case shows its deadline (noted while online) and the personal-data warning.
    await expect(page.getByTestId('due').first()).not.toHaveText('—');
    await expect(page.getByTestId('device-privacy')).toContainText('personal data');

    // The app shell is cached; with no connection a reload still opens the device page.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'My device' })).toBeVisible();
    await expect(page.getByTestId('connection')).toHaveText('Offline');
    await expect(page.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await expect(page.getByText('Available when the connection is back.')).toBeVisible();
    await expect(rows).toHaveCount(3);
    await expect(page.getByTestId('due').first()).not.toHaveText('—');
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
    await expect(page.getByTestId('waiting')).toHaveText('3interviews to send');
    await expect(page.getByTestId('waiting')).toHaveAttribute('data-count', '3');

    // Back online: sent, submitted and returned without doing anything.
    await context.setOffline(false);
    await expect(page.getByTestId('connection')).toHaveText('Online');
    await expect(page.getByTestId('device-message')).toContainText(
      'Synced: 3 interviews sent, 3 cases returned.',
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('waiting')).toHaveAttribute('data-count', '0');
    const done = await db.all(
      `select external_id, status, disposition, checked_out_device from cases where external_id in (${marks(ids.length)})`,
      ids,
    );
    expect(done).toHaveLength(3);
    for (const c of done)
      expect(c).toMatchObject({
        status: 'finalised',
        disposition: 'REFUSAL',
        checked_out_device: null,
      });
    const offline = await db.all(
      `select count(*) as n from case_events e join cases c on c.id = e.case_id
       where c.external_id in (${marks(ids.length)}) and e.type = 'interview_started' and json_value(e.details, '$.offline') = 'true'`,
      ids,
    );
    expect(Number(offline[0]!.n)).toBe(3);

    // Signing out with a case still on the device offers to give it back and remove it.
    const box = page.getByTestId('download-list').getByRole('checkbox').last();
    const kept = (await box.getAttribute('aria-label'))!.replace('Download case ', '');
    await box.check();
    await page.getByRole('button', { name: 'Download selected' }).click();
    await expect(page.getByTestId('device-message')).toContainText('1 case downloaded.');

    // The supervisor sees, on the live dashboard, who holds cases on a device and when it last
    // synchronised (169).
    const sup = await context.browser()!.newPage();
    await login(sup, SUPERVISOR);
    await pickOrganisation(sup, 'Demo Research');
    await sup
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Projects', exact: true })
      .click();
    await sup.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
    await resultsSection(sup, 'Dashboard');
    const held = sup.getByTestId('team-devices').locator('tr[data-user="Demo interviewer"]');
    await expect(held).toContainText('1');
    await expect(held).toContainText(/now|second|minute/);
    await held.scrollIntoViewIfNeeded();
    await shot(sup, 'v2-dashboard-devices', { fullPage: false });
    await sup.close();

    await page.getByRole('button', { name: 'Sign out' }).click();
    const leave = page.getByRole('dialog', { name: 'Before you sign out' });
    await expect(leave).toContainText('This device keeps 1 downloaded case, with personal data.');
    await shot(page, 'device-sign-out');
    await leave.getByRole('button', { name: 'Give back, remove and sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    const back = await db.all(`select checked_out_device from cases where external_id = ?`, [kept]);
    expect(back[0]).toMatchObject({ checked_out_device: null });
    const left = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const open = indexedDB.open('wansurvey');
          open.onsuccess = () => {
            const r = open.result.transaction('cases').objectStore('cases').count();
            r.onsuccess = () => resolve(r.result);
          };
        }),
    );
    expect(left).toBe(0);
  } finally {
    await db.end();
  }
});
