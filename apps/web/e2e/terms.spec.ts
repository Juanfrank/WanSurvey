import { expect, test } from '@playwright/test';
import { connectDb } from './db.js';
import { expectAccessible, login, shot } from './helpers.js';

const EMAIL = 'data.entry@demo.wansurvey.test';

test('a person accepts the terms of use and confidentiality before working, and it is recorded', async ({
  page,
}) => {
  const db = connectDb();
  try {
    // This person has not accepted yet (the demo accounts come already accepted).
    await db.run(
      'UPDATE users SET terms_version = NULL, terms_accepted_at = NULL WHERE email = ?',
      [EMAIL],
    );
    await login(page, EMAIL);
    const gate = page.getByTestId('terms-gate');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Terms of use', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /Confidentiality/ })).toBeVisible();
    await shot(page, 'terms-gate', { fullPage: true });
    await expectAccessible(page);

    // Nothing to go on with until the box is ticked.
    const go = gate.getByRole('button', { name: 'Accept and continue' });
    await expect(go).toBeDisabled();
    await gate
      .getByLabel('I have read and accept the terms of use and the confidentiality undertaking')
      .check();
    await go.click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByTestId('terms-gate')).toHaveCount(0);

    // Recorded with the version, and in the activity log.
    const row = (
      await db.all('SELECT terms_version, terms_accepted_at FROM users WHERE email = ?', [EMAIL])
    )[0]!;
    expect(row.terms_version).toBe(1);
    expect(row.terms_accepted_at).not.toBeNull();
    const audit = await db.all(
      "SELECT TOP (1) action FROM audit_log WHERE action = 'user.terms_accepted' ORDER BY at DESC",
    );
    expect(audit).toHaveLength(1);
  } finally {
    // The demo accounts stay accepted for the other tests.
    await db.run(
      'UPDATE users SET terms_version = 1, terms_accepted_at = SYSDATETIMEOFFSET() WHERE email = ?',
      [EMAIL],
    );
    await db.end();
  }
});

test('the terms of use can be read by anyone, without signing in', async ({ page }) => {
  await page.goto('/terms');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Terms of use', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('terms-gate')).toHaveCount(0);
  await expectAccessible(page);
});
