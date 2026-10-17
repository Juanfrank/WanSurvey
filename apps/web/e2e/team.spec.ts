import { expect, test, type Browser, type Page } from '@playwright/test';
import { totp } from '../../api/dist/common/crypto.js';
import { expectAccessible, login, PASSWORD, shot } from './helpers.js';
import { sentMail } from './mail.js';

const ADMIN = 'admin@demo.wansurvey.test';
const STAMP = Date.now() % 100000;
const INES = `ines.${STAMP}@example.org`;
const PABLO = `pablo.${STAMP}@example.org`;

/** Admins enrol a second factor on their first sign-in; the code comes from the key shown. */
async function signInAdmin(page: Page) {
  await login(page, ADMIN);
  await page.waitForURL(/\/login\/2fa/);
  if (page.url().includes('/setup')) {
    const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
    await page.getByLabel('Code').fill(totp(secret));
    await page.getByRole('button', { name: 'Turn on' }).click();
  } else throw new Error('The admin was expected to enrol here');
  await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
}

/** The path of the link in the latest e-mail to someone. */
const linkTo = (email: string) => {
  const text = sentMail()
    .filter((m) => m.to === email)
    .at(-1)!.text;
  const url = new URL(/https?:\/\/\S+/.exec(text)![0]);
  return url.pathname + url.search;
};

async function freshPage(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

test('the team: invite, accept, change roles, deactivate and reactivate; others only look', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signInAdmin(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Users', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  const team = page.getByTestId('team');
  await expect(team.locator(`[data-member="${ADMIN}"]`)).toContainText('(you)');
  // Nobody manages their own roles.
  await expect(
    team.locator(`[data-member="${ADMIN}"]`).getByRole('button', { name: /^Actions for/ }),
  ).toHaveCount(0);

  // Invite Inés as an interviewer in one project.
  await page.getByRole('button', { name: 'Invite a person' }).click();
  await page.getByLabel('E-mail', { exact: true }).fill(INES);
  await page.getByLabel('Full name').fill('Inés Invitada');
  await page.getByLabel('Staff code (optional)').fill('E-207');
  await page
    .getByLabel('Where 1', { exact: true })
    .selectOption({ label: 'Household Survey 2026' });
  await expect(
    page.getByTestId('role-row').getByText('Conducts the interviews of their cases'),
  ).toBeVisible();
  await shot(page, 'team-invite');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(`Invitation sent to ${INES}.`)).toBeVisible();
  const ines = team.locator(`[data-member="${INES}"]`);
  await expect(ines).toHaveAttribute('data-status', 'invited');
  await expect(ines).toContainText('Interviewer · in Household Survey 2026');

  // A second person, whose first link gets lost: a new one replaces it.
  await page.getByRole('button', { name: 'Invite a person' }).click();
  await page.getByLabel('E-mail', { exact: true }).fill(PABLO);
  await page.getByLabel('Full name').fill('Pablo Pérez');
  await page.getByLabel('Role 1', { exact: true }).selectOption({ label: 'Reviewer' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(`Invitation sent to ${PABLO}.`)).toBeVisible();
  const lost = linkTo(PABLO);
  await page.getByRole('button', { name: 'Actions for Pablo Pérez' }).click();
  await page.getByRole('menuitem', { name: 'Send the invitation again' }).click();
  await expect(page.getByText(/earlier links no longer work/)).toBeVisible();
  expect(linkTo(PABLO)).not.toBe(lost);

  // Inés accepts in her own browser, choosing a password, and signs in.
  const inesBrowser = await freshPage(browser);
  await inesBrowser.page.goto(linkTo(INES));
  await expect(
    inesBrowser.page.getByRole('heading', { name: 'Accept your invitation' }),
  ).toBeVisible();
  await inesBrowser.page.getByLabel('Password', { exact: true }).fill('short');
  await inesBrowser.page.getByRole('button', { name: 'Accept and continue' }).click();
  await expect(inesBrowser.page.getByRole('alert')).toContainText('at least 10 characters');
  await inesBrowser.page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await inesBrowser.page.getByLabel('Repeat the password').fill(PASSWORD);
  await shot(inesBrowser.page, 'team-accept-invitation');
  await inesBrowser.page.getByRole('button', { name: 'Accept and continue' }).click();
  await expect(inesBrowser.page.getByText('Your invitation was accepted.')).toBeVisible();
  await inesBrowser.page.getByRole('link', { name: 'Go to sign in' }).click();
  await login(inesBrowser.page, INES);
  await expect(inesBrowser.page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  // An interviewer does not see the team.
  await expect(
    inesBrowser.page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Administration' }),
  ).toHaveCount(0);

  // The admin sees her active, then makes her a supervisor of the whole organisation.
  await page.reload();
  await expect(ines).toHaveAttribute('data-status', 'active');
  await page.getByRole('button', { name: 'Actions for Inés Invitada' }).click();
  await page.getByRole('menuitem', { name: 'Change roles…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Roles of Inés Invitada' });
  await dialog.getByLabel('Role 1', { exact: true }).selectOption({ label: 'Supervisor' });
  await dialog.getByLabel('Where 1', { exact: true }).selectOption({ label: 'Whole organisation' });
  await dialog.getByRole('button', { name: 'Add a role' }).click();
  await dialog.getByLabel('Role 2', { exact: true }).selectOption({ label: 'Interviewer' });
  await dialog
    .getByLabel('Where 2', { exact: true })
    .selectOption({ label: 'Household Survey 2026' });
  await shot(page, 'team-roles');
  await dialog.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.getByText('Roles of Inés Invitada saved.')).toBeVisible();
  await expect(ines).toContainText('Supervisor · Whole organisation');
  await expect(ines).toContainText('Interviewer · in Household Survey 2026');

  // Deactivated, she cannot sign in; reactivated, she can again.
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Actions for Inés Invitada' }).click();
  await page.getByRole('menuitem', { name: 'Deactivate…' }).click();
  await expect(ines).toHaveAttribute('data-status', 'deactivated');
  const again = await freshPage(browser);
  await login(again.page, INES);
  await expect(again.page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Status').selectOption('deactivated');
  await expect(page.getByText('1 person')).toBeVisible();
  await shot(page, 'team-list');
  await page.getByLabel('Status').selectOption('');
  await page.getByRole('button', { name: 'Actions for Inés Invitada' }).click();
  await page.getByRole('menuitem', { name: 'Reactivate' }).click();
  await expect(ines).toHaveAttribute('data-status', 'active');
  await login(again.page, INES);
  await expect(again.page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  await expectAccessible(page);
  await again.ctx.close();
  await inesBrowser.ctx.close();

  // She forgets her password: the link from the e-mail sets a new one.
  const forgot = await freshPage(browser);
  await forgot.page.goto('/login');
  await forgot.page.getByRole('link', { name: 'Forgot your password?' }).click();
  await forgot.page.getByLabel('E-mail', { exact: true }).fill(INES);
  await forgot.page.getByRole('button', { name: 'Send link' }).click();
  await expect(forgot.page.getByText(/a link is on its way/)).toBeVisible();
  await expect.poll(() => sentMail().filter((m) => m.to === INES).length).toBe(2);
  await forgot.page.goto(linkTo(INES));
  await forgot.page.getByLabel('Password', { exact: true }).fill('a brand new passphrase');
  await forgot.page.getByLabel('Repeat the password').fill('something else');
  await forgot.page.getByRole('button', { name: 'Save password' }).click();
  await expect(forgot.page.getByRole('alert')).toContainText('not the same');
  await forgot.page.getByLabel('Repeat the password').fill('a brand new passphrase');
  await forgot.page.getByRole('button', { name: 'Save password' }).click();
  await expect(forgot.page.getByText('Your password was changed.')).toBeVisible();
  await forgot.ctx.close();

  // A project manager sees the team but cannot change it.
  const pm = await freshPage(browser);
  await login(pm.page);
  await expect(pm.page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  await pm.page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Administration' })
    .click();
  await expect(
    pm.page.getByText('You can see the users; an administrator changes them.'),
  ).toBeVisible();
  await expect(pm.page.getByRole('button', { name: 'Invite a person' })).toHaveCount(0);
  await expect(pm.page.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
  await pm.ctx.close();

  // Teams: a field crew led by the supervisor, with Inés in it.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Teams', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible();
  await page.getByRole('button', { name: 'New team' }).click();
  const crew = page.getByRole('dialog', { name: 'New team' });
  await crew.getByLabel('Name').fill('Cuadrilla Norte');
  await crew.getByRole('combobox', { name: 'Leader' }).selectOption({ label: 'Demo supervisor' });
  await crew.getByRole('checkbox', { name: /Inés Invitada/ }).check();
  await crew.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByText('Team Cuadrilla Norte created.')).toBeVisible();
  await expect(page.locator('[data-team="Cuadrilla Norte"]')).toContainText('2 members');
  await shot(page, 'admin-teams');
  await expectAccessible(page);

  // Roles and permissions: reviewers may also see the dashboard, then back to the defaults.
  await nav.getByRole('link', { name: 'Roles and permissions' }).click();
  const matrix = page.getByTestId('roles-matrix');
  const allow = matrix.getByRole('checkbox', {
    name: 'Reviewer: See the dashboard and results',
  });
  await expect(allow).not.toBeChecked();
  await allow.check();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.getByText('Permissions saved.')).toBeVisible();
  await shot(page, 'admin-roles');
  await expectAccessible(page);
  await page.reload();
  await expect(allow).toBeChecked();
  await page.getByRole('button', { name: 'Defaults for Reviewer' }).click();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.getByText('Permissions saved.')).toBeVisible();
  await page.reload();
  await expect(allow).not.toBeChecked();

  // Where roles are given, a guide says what each one may do.
  await nav.getByRole('link', { name: 'Users', exact: true }).click();
  await page.getByRole('button', { name: 'Invite a person' }).click();
  await page.getByTestId('role-guide').getByText('What can each role do?').click();
  await expect(page.getByTestId('role-guide').locator('[data-role="interviewer"]')).toContainText(
    'Key paper forms',
  );
  await shot(page, 'role-guide');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // The organisation: defaults for new projects.
  await nav.getByRole('link', { name: 'Organisation', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Time zone of new projects' })
    .selectOption('America/Lima');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Organisation saved.')).toBeVisible();
  await shot(page, 'admin-organisation');
  await expectAccessible(page);

  // The activity log has it all.
  await nav.getByRole('link', { name: 'Activity log' }).click();
  await page.getByRole('combobox', { name: 'Action' }).selectOption('team.created');
  await expect(page.locator('tr[data-action="team.created"]')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Action' }).selectOption('');
  await expect(page.locator('tr[data-action="user.invited"]').first()).toBeVisible();
  await shot(page, 'admin-audit', { fullPage: false });
  await expectAccessible(page);
});
