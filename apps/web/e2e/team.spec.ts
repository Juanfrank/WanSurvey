import { expect, overlaysSettled, test, type Browser, type Page } from './fixtures.js';
import { totp } from '../../api/dist/common/crypto.js';
import { closeFilters, expectAccessible, login, openFilters, PASSWORD, shot } from './helpers.js';
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
  await page.getByRole('button', { name: 'Invite a user' }).click();
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
  await page.getByRole('button', { name: 'Invite a user' }).click();
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
  // A person invited just now accepts the terms of use before working.
  const gate = inesBrowser.page.getByTestId('terms-gate');
  await expect(gate).toBeVisible();
  await gate
    .getByLabel('I have read and accept the terms of use and the confidentiality undertaking')
    .check();
  await gate.getByRole('button', { name: 'Accept and continue' }).click();
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
  await overlaysSettled(page, 1);
  const dialog = page.getByRole('dialog', { name: 'Roles of Inés Invitada' });
  await dialog.getByLabel('Role 1', { exact: true }).selectOption({ label: 'Supervisor' });
  await dialog.getByLabel('Where 1', { exact: true }).selectOption({ label: 'Whole organisation' });
  await dialog.getByRole('button', { name: 'Add a role' }).click();
  await dialog.getByLabel('Role 2', { exact: true }).selectOption({ label: 'Interviewer' });
  await dialog
    .getByLabel('Where 2', { exact: true })
    .selectOption({ label: 'Household Survey 2026' });
  // A supervisor does not conduct interviews: that row adds something. A reviewer row would not.
  await expect(dialog.getByTestId('redundant-row')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Add a role' }).click();
  await dialog.getByLabel('Role 3', { exact: true }).selectOption({ label: 'Reviewer' });
  await dialog
    .getByLabel('Where 3', { exact: true })
    .selectOption({ label: 'Household Survey 2026' });
  await expect(dialog.getByTestId('redundant-row')).toHaveText(
    'This row adds nothing: Supervisor · Whole organisation already includes it.',
  );
  await shot(page, 'team-roles');
  // Each field has a short label; what the role does is a line under the whole row.
  await expect(
    dialog.getByTestId('role-row').first().getByText('Role', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Role 1', { exact: true })).toHaveAccessibleDescription(
    /Follows fieldwork/,
  );
  await shot(page, 'v2-team-roles-short-labels');
  await dialog.getByRole('button', { name: 'Remove role 3' }).click();
  await expect(dialog.getByTestId('redundant-row')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.getByText('Roles of Inés Invitada saved.')).toBeVisible();
  await expect(ines).toContainText('Supervisor · Whole organisation');
  await expect(ines).toContainText('Interviewer · in Household Survey 2026');
  // Who is an interviewer in Household Survey 2026? The filters are behind "Filters".
  await openFilters(page);
  await page.getByRole('combobox', { name: /^Role/ }).selectOption({ label: 'Interviewer' });
  await page
    .getByRole('combobox', { name: /^Project/ })
    .selectOption({ label: 'Household Survey 2026' });
  await expect(ines).toBeVisible();
  await expect(team.locator(`[data-member="${ADMIN}"]`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Filters · 2/ })).toBeVisible();
  await shot(page, 'p2-users-filters', { fullPage: false });
  await closeFilters(page);
  await expect(page.getByRole('button', { name: 'Remove filter: Role Interviewer' })).toBeVisible();
  await shot(page, 'p2-users-chips');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(team.locator(`[data-member="${ADMIN}"]`)).toBeVisible();

  // Before deactivating someone with open cases, the dialog lists them to reassign first.
  await page.getByRole('button', { name: 'Actions for Demo interviewer' }).click();
  await page.getByRole('menuitem', { name: 'Deactivate…' }).click();
  const leave = page.getByRole('dialog', { name: 'Deactivate Demo interviewer?' });
  await expect(leave.getByTestId('deactivate-cases')).toContainText(
    /\d+ open cases? in Household Survey 2026/,
  );
  await expect(
    leave.getByRole('link', { name: 'Open the cases of Household Survey 2026' }),
  ).toBeVisible();
  await shot(page, 'team-deactivate');
  await leave.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('[data-member="interviewer@demo.wansurvey.test"]')).toHaveAttribute(
    'data-status',
    'active',
  );

  // Deactivated, she cannot sign in; reactivated, she can again.
  await page.getByRole('button', { name: 'Actions for Inés Invitada' }).click();
  await page.getByRole('menuitem', { name: 'Deactivate…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Deactivate Inés Invitada?' });
  await expect(confirm).toContainText('They have no open cases.');
  await confirm.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(ines).toHaveAttribute('data-status', 'deactivated');
  await expect(ines).toContainText('Without effect while deactivated');
  const again = await freshPage(browser);
  await login(again.page, INES);
  await expect(again.page.getByRole('alert')).toBeVisible();
  await openFilters(page);
  await page.getByRole('combobox', { name: 'Status' }).selectOption('deactivated');
  await closeFilters(page);
  await expect(page.getByText('1 user')).toBeVisible();
  // One row fits without scrolling sideways: no shade over the "⋯".
  await expect(page.getByRole('region', { name: 'Users' })).not.toHaveAttribute('data-scrolls');
  await shot(page, 'team-list');
  await page.getByRole('button', { name: 'Remove filter: Status Deactivated' }).click();
  // The message itself undoes it.
  await expect(page.getByText('Inés Invitada was deactivated.')).toBeVisible();
  await page.getByRole('button', { name: 'Reactivate', exact: true }).click();
  await expect(page.getByText('Inés Invitada can sign in again.')).toBeVisible();
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
  // Fill again until the form has taken the address (a fill that lands while the page is still
  // settling can be lost, leaving the button disabled).
  await expect(async () => {
    await forgot.page.getByLabel('E-mail', { exact: true }).fill(INES);
    await expect(forgot.page.getByRole('button', { name: 'Send link' })).toBeEnabled({
      timeout: 2000,
    });
  }).toPass({ timeout: 30_000 });
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

  // A project manager's menu lists only what they manage (the registry), not the team; the
  // team is still there, read only, at its address.
  const pm = await freshPage(browser);
  await login(pm.page);
  await expect(pm.page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  const pmNav = pm.page.getByRole('navigation', { name: 'Main' });
  await expect(pmNav.getByRole('link', { name: 'People registry' })).toBeVisible();
  await expect(pmNav.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
  await expect(pmNav.getByRole('link', { name: 'Teams', exact: true })).toHaveCount(0);
  await pm.page.goto('/admin/users');
  await expect(
    pm.page.getByText('You can see the users; an administrator changes them.'),
  ).toBeVisible();
  await expect(pm.page.getByRole('button', { name: 'Invite a user' })).toHaveCount(0);
  await expect(pm.page.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
  // Without two-step verification, the account menu offers to turn it on.
  await pm.page.getByRole('button', { name: /^Account:/ }).click();
  const enable = pm.page.getByRole('link', { name: 'Turn on two-step verification' });
  await expect(enable).toHaveAttribute('href', '/login/2fa/setup');
  await shot(pm.page, 'v2-account-menu-enable-2fa', { fullPage: false });
  await enable.click();
  await expect(pm.page.getByTestId('totp-secret')).toBeVisible();
  // An address that leads nowhere says so, with a way home.
  await pm.page.goto('/no-such-page');
  await expect(pm.page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await shot(pm.page, 'v2-not-found');
  await pm.page.getByRole('link', { name: 'Go to the home page' }).click();
  await expect(pm.page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  await pm.ctx.close();

  // Teams: a field crew led by the supervisor, with Inés in it.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Teams', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible();
  await page.getByRole('button', { name: 'New team' }).click();
  await overlaysSettled(page, 2);
  const crew = page.getByRole('dialog', { name: 'New team' });
  await crew.getByLabel('Name').fill('Cuadrilla Norte');
  await crew.getByRole('combobox', { name: 'Leader' }).selectOption({ label: 'Demo supervisor' });
  await crew.getByRole('checkbox', { name: /Inés Invitada/ }).check();
  await crew.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByText('Team Cuadrilla Norte created.')).toBeVisible();
  await expect(page.locator('[data-team="Cuadrilla Norte"]')).toContainText('2 members');
  await expect(page.getByRole('button', { name: 'Actions for Cuadrilla Norte' })).toBeVisible();
  await shot(page, 'admin-teams');
  await expectAccessible(page);

  // Roles and permissions: reviewers may also see the dashboard, then back to the defaults.
  await nav.getByRole('link', { name: 'Roles and permissions' }).click();
  const matrix = page.getByTestId('roles-matrix');
  // The areas are folded, each with how many of its permissions every role has.
  const results = matrix.getByRole('button', { name: /^Results/ });
  await expect(results).toHaveAttribute('aria-expanded', 'false');
  await shot(page, 'p2-roles-folded');
  await results.click();
  await matrix.getByRole('button', { name: /^Privacy/ }).click();
  const allow = matrix.getByRole('checkbox', {
    name: 'Reviewer: See the dashboard and results',
  });
  await expect(allow).not.toBeChecked();
  await allow.check();
  await expect(page.getByTestId('roles-unsaved')).toHaveText('1 unsaved change');
  await expect(allow).toHaveAccessibleName('Reviewer: See the dashboard and results (changed)');
  // Saving shows what changes first; a sensitive permission is pointed out.
  const pii = matrix.getByRole('checkbox', { name: 'Reviewer: See personal data' });
  await pii.check();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await overlaysSettled(page, 3);
  const saveDialog = page.getByRole('dialog', { name: 'Save these permissions?' });
  await expect(saveDialog.locator('[data-role="reviewer"] [data-given="pii.view"]')).toContainText(
    'personal data',
  );
  await shot(page, 'admin-roles-confirm');
  await saveDialog.getByRole('button', { name: 'Cancel' }).click();
  await pii.uncheck();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await page
    .getByRole('dialog', { name: 'Save these permissions?' })
    .getByRole('button', { name: 'Save the permissions' })
    .click();
  await expect(page.getByText('Permissions saved.')).toBeVisible();
  await expect(page.getByTestId('roles-unsaved')).toHaveCount(0);
  await shot(page, 'admin-roles');
  await expectAccessible(page);
  await page.reload();
  await page.getByRole('button', { name: 'Unfold every area' }).click();
  await expect(allow).toBeChecked();
  await page.getByRole('button', { name: 'Defaults for Reviewer' }).click();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await page
    .getByRole('dialog', { name: 'Save these permissions?' })
    .getByRole('button', { name: 'Save the permissions' })
    .click();
  await expect(page.getByText('Permissions saved.')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Unfold every area' }).click();
  await expect(allow).not.toBeChecked();
  // Unfolded and scrolled, the row of role names stays at the top.
  await page.getByRole('region', { name: 'Roles and permissions' }).evaluate((el) => {
    el.scrollTop = 600;
  });
  await expect(matrix.getByRole('columnheader', { name: /^Reviewer/ })).toBeInViewport();
  // Short role names keep every column in view, the last one (Client) included.
  await expect(matrix.getByRole('columnheader', { name: /^Client \(read only\)/ })).toBeInViewport({
    ratio: 1,
  });
  await shot(page, 'p2-roles-sticky-header', { fullPage: false });

  // Where roles are given, a guide says what each one may do.
  await nav.getByRole('link', { name: 'Users', exact: true }).click();
  await page.getByRole('button', { name: 'Invite a user' }).click();
  await page.getByTestId('role-guide').getByText('What can each role do?').click();
  await expect(page.getByTestId('role-guide').locator('[data-role="interviewer"]')).toContainText(
    'Key paper forms',
  );
  await expect(
    page.getByRole('link', { name: 'Every permission of every role, in Roles and permissions' }),
  ).toHaveAttribute('href', '/admin/roles');
  await shot(page, 'role-guide');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // The organisation: defaults for new projects.
  await nav.getByRole('link', { name: 'Organisation', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Time zone of new projects' })
    .selectOption('America/Lima');
  await page
    .locator('form')
    .filter({ has: page.getByRole('combobox', { name: 'Time zone of new projects' }) })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByText('Organisation saved.')).toBeVisible();
  await shot(page, 'admin-organisation');
  await expectAccessible(page);
  // A new project takes that zone, whatever the browser's.
  await nav.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByText('Time zone: America/Lima')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // The activity log has it all.
  await nav.getByRole('link', { name: 'Activity log' }).click();
  await openFilters(page);
  await page.getByRole('combobox', { name: 'Action' }).selectOption('team.created');
  await expect(page.locator('tr[data-action="team.created"]')).toHaveCount(1);
  // Actions read in words, with the code beside them.
  await expect(page.locator('tr[data-action="team.created"]')).toContainText('Created a team');
  await page.getByRole('combobox', { name: 'Action' }).selectOption('');
  await expect(page.locator('tr[data-action="user.invited"]').first()).toBeVisible();
  // A quick filter, and a change of permissions shown as what was added and removed.
  await page.getByRole('button', { name: 'Roles and permissions', exact: true }).click();
  await expect(page.locator('tr[data-action="user.invited"]').first()).toBeVisible();
  await expect(page.locator('tr[data-action="team.created"]')).toHaveCount(0);
  await shot(page, 'p2-audit-filters', { fullPage: false });
  await closeFilters(page);
  await expect(
    page.getByRole('button', { name: 'Remove filter: Quick filters Roles and permissions' }),
  ).toBeVisible();
  const change = page.locator('tr[data-action="tenant.roles_updated"]').first();
  const toggle = change.getByRole('button', { name: /^View details: Changed role permissions/ });
  const panel = page.locator(`[id="${await toggle.getAttribute('aria-controls')}"]`);
  await toggle.click();
  await expect(change.getByRole('button', { name: 'Hide details' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(panel).toContainText('Reviewer');
  await expect(panel).toContainText('− See the dashboard and results');
  await shot(page, 'admin-audit', { fullPage: false });
  await expectAccessible(page);

  // The administration opens on an overview: what needs attention, then the sections by block.
  await nav.getByRole('link', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Needs attention' })).toBeVisible();
  await expect(page.getByTestId('admin-attention').locator('[data-tile="awaiting"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Security and integrations' }),
  ).toBeVisible();
  await shot(page, 'admin-home');
  await expectAccessible(page);

  // Each count opens Users with its filter on.
  await page.getByTestId('admin-attention').locator('[data-tile="awaiting"] a').click();
  await expect(page).toHaveURL(/\/admin\/users\?status=awaiting/);
  await expect(
    page.getByRole('button', { name: 'Remove filter: Status Waiting for a role' }),
  ).toBeVisible();
  await expect(team.locator('tbody tr').first()).toHaveAttribute('data-status', 'awaiting');
  await shot(page, 'v2-admin-tile-awaiting-users');
  await nav.getByRole('link', { name: 'Administration', exact: true }).click();
  const no2fa = page.getByTestId('admin-attention').locator('[data-tile="without2fa"]');
  const missing = Number(await no2fa.getAttribute('data-count'));
  await no2fa.locator('a').click();
  await expect(page).toHaveURL(/twoStep=required/);
  await expect(
    page.getByRole('button', {
      name: 'Remove filter: Two-step sign-in Required by their role, not set up',
    }),
  ).toBeVisible();
  await expect(team.locator('tbody tr')).toHaveCount(missing);
  // Everyone active without it, whatever their role.
  await openFilters(page);
  await page.getByRole('combobox', { name: 'Two-step sign-in' }).selectOption('off');
  await closeFilters(page);
  await expect(page).toHaveURL(/twoStep=off/);
  await expect(team.locator(`[data-member="interviewer@demo.wansurvey.test"]`)).toBeVisible();
  await expect(team.locator(`[data-member="${ADMIN}"]`)).toHaveCount(0);
  await shot(page, 'v2-users-without-2fa-filter');
  await page
    .getByRole('button', { name: 'Remove filter: Two-step sign-in Without two-step verification' })
    .click();
  await expect(page).not.toHaveURL(/twoStep=/);

  // A person's activity, from their actions.
  await page.getByRole('button', { name: 'Actions for Demo interviewer' }).click();
  await expect(page.getByRole('menuitem', { name: 'See their activity' })).toBeVisible();
  await shot(page, 'v2-users-actions-activity', { fullPage: false });
  await page.getByRole('menuitem', { name: 'See their activity' }).click();
  await expect(page).toHaveURL(/\/admin\/audit\?actor=/);
  await expect(
    page.getByRole('button', { name: 'Remove filter: Who Demo interviewer' }),
  ).toBeVisible();
  await openFilters(page);
  await expect(page.getByRole('combobox', { name: 'Who' })).toHaveValue(
    new URL(page.url()).searchParams.get('actor')!,
  );
  await closeFilters(page);
  await shot(page, 'v2-audit-from-user-actions', { fullPage: false });

  // Giving a client a role that opens interviews asks why, also from Users.
  await nav.getByRole('link', { name: 'Users', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for Demo client_viewer' }).click();
  await page.getByRole('menuitem', { name: 'Change roles…' }).click();
  const client = page.getByRole('dialog', { name: 'Roles of Demo client_viewer' });
  await client.getByRole('button', { name: 'Add a role' }).click();
  await client.getByLabel('Role 2', { exact: true }).selectOption({ label: 'Reviewer' });
  await client
    .getByLabel('Where 2', { exact: true })
    .selectOption({ label: 'Household Survey 2026' });
  const warning = client.getByTestId('external-warning');
  await expect(warning).toContainText('Listen to interview recordings');
  await expect(client.getByRole('button', { name: 'Save roles' })).toBeDisabled();
  await warning.getByRole('textbox').fill('Audits the fieldwork for the client');
  await expect(client.getByRole('button', { name: 'Save roles' })).toBeEnabled();
  // The reason's field is clear of the dialog's footer (it scrolled into view when it appeared).
  const reasonBox = await warning.getByRole('textbox').boundingBox();
  const footerBox = await client.locator('[data-sticky-footer]').boundingBox();
  expect(reasonBox!.y + reasonBox!.height).toBeLessThanOrEqual(footerBox!.y);
  // Not the whole page: a full-page capture lays the dialog out again, scrolled back to its top.
  await shot(page, 'v2-team-roles-external-reason', { fullPage: false });
  await client.getByRole('button', { name: 'Cancel' }).click();

  // An administrator sees the webhooks, read only, as the API keys.
  await nav.getByRole('link', { name: 'Webhooks', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Webhooks' })).toBeVisible();
  // "Read only" is a badge beside the title; its (i) says who changes them.
  await expect(page.getByText('Read only', { exact: true })).toBeVisible();
  await expect(page.getByText(/You can see the webhooks and their deliveries/)).toBeHidden();
  await page.getByRole('button', { name: 'About: Read only' }).focus();
  await expect(page.getByText(/You can see the webhooks and their deliveries/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 700);
  await expect(page.getByText(/You can see the webhooks and their deliveries/)).toBeHidden();
  await expect(page.getByRole('button', { name: 'New webhook' })).toHaveCount(0);
  await shot(page, 'v2-webhooks-read-only');
  await expectAccessible(page);
});
