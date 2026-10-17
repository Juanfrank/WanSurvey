import { hash } from '@node-rs/argon2';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import {
  PASSWORD,
  PM,
  expectAccessible,
  login,
  pickOrganisation,
  questionnaireAction,
  shot,
} from './helpers.js';

const CLERK = 'data.entry@demo.wansurvey.test';
const CLERK2 = 'second.clerk@demo.wansurvey.test';
const SUPERVISOR = 'supervisor@demo.wansurvey.test';
const adminUrl =
  process.env.E2E_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/wansurvey_e2e';

async function openPaper(page: Page, email: string) {
  await login(page, email);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await questionnaireAction(page, 'Paper forms');
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

/** Keys the form by keyboard: consent yes, then the age; under 18 ends it (screened out). */
async function keyForm(page: Page, caseId: string, age: string) {
  const box = page.getByLabel('Case id on the form (type it or scan the QR code)');
  await box.fill(caseId);
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: new RegExp(`Case ${caseId}`) })).toBeVisible();
  await onQuestion(page, 'A0_CONSENT_TEXT');
  await page.keyboard.press('Enter');
  await onQuestion(page, 'A1');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await onQuestion(page, 'A2');
  await page.keyboard.type(age);
  await page.keyboard.press('Enter');
  // The date and duration written on the paper.
  const meta = page.getByTestId('paper-meta');
  await meta.getByLabel('Interview date on the form').fill('2026-10-10');
  await meta.getByLabel('Duration on the form (minutes)').fill('25');
  await meta.getByLabel('Duration on the form (minutes)').press('Tab');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved', {
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'Submit interview' }).click();
  await expect(page.getByTestId('key-message')).toContainText('Form keyed');
}

test('print forms with QR codes, key them twice, and resolve the difference', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    // A second clerk, and a case for the first one.
    const [demo] = await sql`select id from tenants where slug = 'demo'`;
    const [clerk] = await sql`select id from users where email = ${CLERK}`;
    const id2 = uuidv7();
    await sql`insert into users (id, email, name, first_name, status, password_hash)
      values (${id2}, ${CLERK2}, 'Second Clerk', 'Second', 'active', ${await hash(PASSWORD, { algorithm: 2 })})`;
    await sql`insert into tenant_members (id, tenant_id, user_id, status) values (${uuidv7()}, ${demo!.id}, ${id2}, 'active')`;
    await sql`insert into memberships (id, tenant_id, user_id, role) values (${uuidv7()}, ${demo!.id}, ${id2}, 'interviewer')`;
    await sql`update cases set assigned_to = ${clerk!.id}, status = 'assigned' where external_id = 'HH0005'`;

    // The project manager keys every form twice and prints forms.
    const pm = await (
      await browser.newContext({ storageState: './e2e/english-ui.json' })
    ).newPage();
    await openPaper(pm, PM);
    await pm.goBack();
    await pm.getByRole('tab', { name: 'Settings', exact: true }).click();
    await pm.getByRole('tab', { name: 'Paper', exact: true }).click();
    await pm.getByLabel(/Key every form twice/).check();
    await pm.getByRole('button', { name: 'Save settings' }).click();
    await expect(pm.getByText('Settings saved.')).toBeVisible();
    await questionnaireAction(pm, 'Paper forms');
    await pm.getByLabel('Only cases where (optional)').fill('case.region == 2');
    await pm.getByLabel('How many').fill('2');
    await pm.getByRole('button', { name: 'Prepare forms' }).click();
    const forms = pm.getByTestId('print').locator('article[data-case]');
    await expect(forms).toHaveCount(2);
    // A QR code where the form starts and where it ends, so a scanned stack splits by case.
    await expect(forms.first().locator('[data-qr] svg')).toHaveCount(2);
    await expect(forms.first().locator('[data-band="start"]')).toContainText(/\w/);
    await expect(forms.first().locator('[data-special]').first()).toBeVisible();
    await expect(forms.first()).toContainText('Q1');
    await shot(pm, 'paper-form-qr');
    await expectAccessible(pm);

    // The first clerk keys case HH0005 by its id: age 15.
    const c1 = await (
      await browser.newContext({ storageState: './e2e/english-ui.json' })
    ).newPage();
    await openPaper(c1, CLERK);
    await keyForm(c1, 'HH0005', '15');
    const [waiting] = await sql`select status from cases where external_id = 'HH0005'`;
    expect(waiting!.status).toBe('in_progress');

    // The second clerk keys the same form and types 16.
    const c2 = await (
      await browser.newContext({ storageState: './e2e/english-ui.json' })
    ).newPage();
    await openPaper(c2, CLERK2);
    const box = c2.getByLabel('Case id on the form (type it or scan the QR code)');
    await box.fill('HH0005');
    await box.press('Enter');
    await expect(c2.getByTestId('paper-meta')).toContainText('Second entry');
    await c2.getByRole('button', { name: 'Suspend and leave' }).click();
    await keyForm(c2, 'HH0005', '16');

    // The supervisor sees the difference and keeps the second value.
    const sup = await (
      await browser.newContext({ storageState: './e2e/english-ui.json' })
    ).newPage();
    await openPaper(sup, SUPERVISOR);
    const row = sup.locator('tr[data-mismatch="HH0005:A2_AGE"]');
    await expect(row).toContainText('15');
    await expect(row).toContainText('16');
    await shot(sup, 'double-entry-mismatches');
    await expectAccessible(sup);
    await row.getByRole('button', { name: /Use second/ }).click();
    await expect(sup.getByTestId('mismatch-message')).toContainText('Case HH0005 is finished.');
    const [done] = await sql`select status, disposition from cases where external_id = 'HH0005'`;
    expect(done).toMatchObject({ status: 'finalised', disposition: 'SCREENED_OUT' });
    const meta =
      await sql`select count(*)::int as n from interview_paradata p join interviews i on i.id = p.interview_id
                join cases c on c.id = i.case_id where c.external_id = 'HH0005' and p.type = 'paper_meta'`;
    expect(meta[0]!.n).toBeGreaterThanOrEqual(2);
  } finally {
    await sql.end();
  }
});
