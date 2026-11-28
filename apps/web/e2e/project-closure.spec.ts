import { expect, test } from './fixtures.js';
import { connectDb } from './db.js';
import { PM, expectAccessible, gotoTab, login, pickOrganisation, shot } from './helpers.js';

const INTERVIEWER = 'interviewer@demo.wansurvey.test';
const PROJECT = 'Household Survey 2026';

/**
 * Closing a project: the checklist says beforehand what happens, field roles stop seeing the
 * project, and an interviewer's device removes what it kept of it once everything was sent.
 * The project is reopened at the end (the other tests use it).
 */
test('closing a project warns first, hides it from field roles and clears their devices', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const db = connectDb();
  const [p] = await db.all(`select id from projects where name = ?`, [PROJECT]);
  const projectId = p!.id as string;
  const field = await browser.newContext();
  try {
    // The interviewer downloads a case to their device.
    const iv = await field.newPage();
    await login(iv, INTERVIEWER);
    await pickOrganisation(iv, 'Demo Research');
    await iv.goto(`/projects/${projectId}/device`);
    await expect(iv.getByRole('heading', { name: 'My device' })).toBeVisible();
    const box = iv.getByTestId('download-list').getByRole('checkbox').last();
    await box.check();
    await iv.getByRole('button', { name: 'Download selected' }).click();
    await expect(iv.getByTestId('device-message')).toContainText('1 case downloaded.');
    await expect(iv.getByTestId('device-cases').locator('tbody tr')).toHaveCount(1);

    // Whoever runs the project sees what closing does before doing it.
    await login(page, PM);
    await pickOrganisation(page, 'Demo Research');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Projects', exact: true })
      .click();
    await page.getByRole('main').getByRole('link', { name: PROJECT }).click();
    await gotoTab(page, 'Project settings');
    await page.getByRole('tab', { name: 'Project status', exact: true }).click();
    const status = page.getByTestId('project-status');
    const effects = status.getByTestId('close-effects');
    await expect(effects).toContainText('Field roles stop seeing the project');
    await expect(effects).toContainText('Web survey links stop opening the survey');
    await expect(
      status.getByTestId('closeout').locator('li[data-item="casesOnDevices"]'),
    ).toContainText('on an interviewer’s device');
    await expect(
      status.getByTestId('closeout').locator('li[data-item="fieldPeople"]'),
    ).toContainText('stop seeing the project');
    await shot(page, 'project-close-warnings');
    await expectAccessible(page);
    page.once('dialog', (d) => {
      expect(d.message()).toContain('field roles stop seeing the project');
      void d.accept();
    });
    await status.getByRole('button', { name: 'Close the project' }).click();
    await expect(status.getByTestId('project-status-current')).toContainText('Closed');
    await expect(status.getByTestId('project-closed-note')).toContainText('Closed on');
    await shot(page, 'project-closed');

    // The interviewer no longer sees the project. Opening the app, the device sends what it
    // holds and, the project being closed, gives the case back and removes it.
    await iv.goto('/projects');
    await expect(iv.getByRole('main').getByRole('link', { name: PROJECT })).toHaveCount(0);
    const onDevices = async () =>
      Number(
        (
          await db.all(
            `select count(*) as n from cases where project_id = ? and checked_out_device is not null`,
            [projectId],
          )
        )[0]!.n,
      );
    await expect.poll(onDevices, { timeout: 20_000 }).toBe(0);
    // "My device" says what happened.
    await iv.goto(`/projects/${projectId}/device`);
    const notice = iv.getByTestId('project-closed');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('data-kept', '0');
    await expect(notice).toContainText('was closed');
    await expect(notice).toContainText('removed from this device');
    await expect(iv.getByTestId('device-cases')).toHaveCount(0);
    await shot(iv, 'device-project-closed');
    await expectAccessible(iv);

    // Reopening gives the access back.
    await status.getByRole('button', { name: 'Reopen' }).click();
    await expect(status.getByTestId('project-status-current')).toContainText('Active');
    await iv.goto('/projects');
    await expect(iv.getByRole('main').getByRole('link', { name: PROJECT })).toBeVisible();
  } finally {
    await field.close();
    await db.run(`update projects set status = 'active', closed_at = null where id = ?`, [
      projectId,
    ]);
    await db.end();
  }
});
