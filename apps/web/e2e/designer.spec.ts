import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, login, shot, pickOrganisation } from './helpers.js';

const outlineItem = (page: Page, name: string) =>
  page.getByRole('treeitem').filter({ has: page.locator(`span.font-mono:text-is("${name}")`) });

/** A topic of the questionnaire's Settings tab. */
async function openSettings(page: Page, topic: string) {
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: topic, exact: true }).click();
}
/** Back to the form editor with its outline. */
const toDesign = (page: Page) => page.getByRole('tab', { name: 'Design', exact: true }).click();

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved', {
    timeout: 10_000,
  });
}

/** Creates a blank questionnaire in the demo project and opens it in the designer. */
async function newQuestionnaire(page: Page, name: string, untick: string[] = []) {
  await login(page);
  // Other specs switch organisation, and the last one used opens by default.
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByRole('link', { name: 'Household Survey 2026' }).click();
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Household questionnaire' })).toBeVisible();
  await page.getByLabel('Questionnaire name').fill(name);
  // Every mode the project uses is ticked to begin with.
  const modes = page.getByTestId('new-q-modes');
  for (const m of untick)
    await modes.getByRole('checkbox', { name: new RegExp(`^${m}`) }).uncheck();
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.getByRole('tree', { name: 'Outline' })).toBeVisible();
  return page.url();
}

/**
 * Adds a question after the focused outline row with the keyboard: Insert opens the grouped
 * menu (single, multi, yes/no, ranking, scale, grid, text, number, date, time, date and time).
 */
async function addWithKeyboard(page: Page, steps: number) {
  await page.keyboard.press('Insert');
  await expect(page.getByRole('menu', { name: 'Add a question' })).toBeVisible();
  for (let i = 0; i < steps; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

/** Renames with F2; names in SEC_A keep the section root "A" in front of what is typed. */
async function rename(page: Page, name: string) {
  await page.keyboard.press('F2');
  const field = page.getByLabel('Variable name');
  await expect(field).toBeFocused();
  await field.fill(name.replace(/^A/, ''));
  await page.keyboard.press('Enter');
  await expect(outlineItem(page, name)).toBeVisible();
}

test('design a questionnaire with the keyboard, preview it and publish v1 and v2', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await newQuestionnaire(page, 'Work module');
  // The outline starts on the first section.
  const section = outlineItem(page, 'SEC_A');
  await section.focus();
  await addWithKeyboard(page, 0); // Single choice, inside the section
  await expect(outlineItem(page, 'A1')).toBeFocused();
  await rename(page, 'A_WORK');
  await page.getByLabel('Question wording (es)').fill('¿Trabaja?');
  await page.getByLabel('Label of option 1 (es)').fill('Sí');
  await page.getByLabel('Label of option 2 (es)').fill('No');

  await outlineItem(page, 'A_WORK').focus();
  await addWithKeyboard(page, 7); // Number
  await rename(page, 'A_HOURS');
  await page.getByLabel('Question wording (es)').fill('¿Cuántas horas por semana?');
  // Typing {{ lists the variables to pipe in; Enter inserts the chosen one.
  const wording = page.getByLabel('Question wording (es)');
  await wording.press('End');
  await wording.pressSequentially(' ({{WO');
  await expect(page.getByTestId('pipe-assist')).toContainText('A_WORK');
  await page.keyboard.press('Enter');
  await expect(wording).toHaveValue('¿Cuántas horas por semana? ({{A_WORK}}');
  await wording.fill('¿Cuántas horas por semana?');
  // The type picker groups the types, with the current one checked.
  await page.getByTestId('type-picker').click();
  const types = page.getByRole('menu', { name: 'Question type' });
  await expect(types.getByRole('group', { name: 'Open answers' })).toBeVisible();
  await expect(types.getByRole('menuitemradio', { name: /Number/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(types).toBeHidden();

  // Skip A_HOURS when A_WORK is No, built with the condition rows.
  await outlineItem(page, 'A_WORK').click();
  await page.getByRole('tab', { name: 'Logic', exact: true }).click();
  await page.getByRole('button', { name: 'Add skip' }).click();
  await page.getByLabel('Condition 1: value', { exact: true }).first().selectOption('2');
  await page.getByLabel('Skip 1: go to').selectOption('END');
  await expect(page.getByTestId('skip-rule')).toContainText('No');
  await saved(page);
  await shot(page, 'designer-logic');
  await expectAccessible(page);

  // Reordering with Alt+arrows and undo.
  await outlineItem(page, 'A_HOURS').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByRole('treeitem').nth(1)).toContainText('A_HOURS');
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('treeitem').nth(1)).toContainText('A_WORK');

  // Preview: A_WORK = No ends the interview without A_HOURS.
  await page.getByRole('tab', { name: 'Preview' }).click();
  await page.locator('[data-qkey="A_WORK"]').focus();
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await expect(page.getByText('The interview is complete. Thank you.')).toBeVisible();
  await expect(page.getByTestId('tracer').locator('[data-key="A_HOURS"]')).toHaveAttribute(
    'data-status',
    'skipped',
  );

  // Publish v1.
  await page.getByRole('button', { name: 'Publish…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish a new version' });
  await expect(dialog).toContainText('First version');
  await expect(dialog).toContainText('No errors');
  await shot(page, 'designer-publish-v1');
  await dialog.getByRole('button', { name: 'Publish version 1' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('versions').locator('[data-version="1"]')).toContainText('In use');

  // Change code 2 to 3: v2 needs a mapping for the old answers.
  await page.getByRole('tab', { name: 'Form' }).click();
  await outlineItem(page, 'A_WORK').click();
  await page.getByLabel('Code of option 2').fill('3');
  await page.getByRole('tab', { name: 'Logic', exact: true }).click();
  await page.getByLabel('Condition 1: value', { exact: true }).first().selectOption('3');
  await saved(page);
  await page.getByRole('button', { name: 'Publish…' }).click();
  await expect(dialog).toContainText('1 change breaks compatibility');
  await expect(dialog.getByRole('button', { name: 'Publish version 2' })).toBeDisabled();
  const mapping = dialog.getByTestId('mapping');
  await expect(mapping).toContainText('lost code(s) 2');
  await mapping.getByLabel('Recode the old answers').check();
  await mapping.getByLabel('New code for 2').selectOption('3');
  await shot(page, 'designer-publish-mapping');
  await expectAccessible(page, 'dialog');
  await expect(dialog.getByRole('button', { name: 'Publish version 2' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Publish version 2' }).click();
  await expect(page.getByTestId('versions').locator('[data-version="2"]')).toContainText('Yes');

  // Compare: the draft equals v2; v1 differs in A_WORK's codes.
  const compare = page.getByTestId('compare');
  await expect(compare.getByTestId('compare-summary')).toHaveText('No differences.');
  await compare.getByLabel('Compare').selectOption({ label: 'v1' });
  await expect(compare.locator('[data-compare-item="A_WORK"]')).toContainText('Edited');
  await expect(compare.locator('[data-compare-item="A_WORK"]')).toContainText('options[3].code');
  await shot(page, 'designer-compare');
  await expectAccessible(page);

  // Drag A_HOURS above A_WORK in the outline; the comparison with v2 shows the move.
  await page.getByRole('tab', { name: 'Form' }).click();
  await outlineItem(page, 'A_HOURS').dragTo(outlineItem(page, 'A_WORK'), {
    targetPosition: { x: 20, y: 2 },
  });
  await expect(page.getByRole('treeitem').nth(1)).toContainText('A_HOURS');
  await saved(page);
  await page.getByRole('tab', { name: 'Versions' }).click();
  await compare.getByLabel('Compare').selectOption({ label: 'v2' });
  await expect(compare.getByTestId('compare-summary')).toHaveText(
    '0 added · 0 removed · 0 edited · 1 moved',
  );

  // Translations: export the CSV, change a Spanish text, import it back.
  await openSettings(page, 'Languages');
  const [csvFile] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export all texts (CSV)' }).click(),
  ]);
  const csv = readFileSync((await csvFile.path())!, 'utf8');
  expect(csv).toContain('A_WORK.text');
  await page.getByLabel('Import translations (.csv or .xlf)').setInputFiles({
    name: 'texts.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv.replace('¿Trabaja?', '¿Trabaja usted?')),
  });
  const preview = page.getByTestId('translation-preview');
  await expect(preview).toContainText('1 text changes');
  await expect(preview).toContainText('¿Trabaja usted?');
  await shot(page, 'designer-translations');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Apply 1 change' }).click();
  await expect(page.getByText(/1 text updated/)).toBeVisible();
  await toDesign(page);
  await outlineItem(page, 'A_WORK').click();
  await expect(page.getByLabel('Question wording (es)')).toHaveValue('¿Trabaja usted?');
  await saved(page);

  // Another language is added as such and edited on its own, one language at a time.
  await openSettings(page, 'Languages');
  const newLang = page.getByLabel('Add language');
  await newLang.fill('en');
  await newLang.locator('xpath=following::button[1]').click();
  await page.getByLabel('Questionnaire language').selectOption('en');
  await toDesign(page);
  await outlineItem(page, 'A_WORK').click();
  await expect(page.getByLabel('Question wording (es)')).toHaveCount(0);
  await page.getByLabel('Question wording (en)').fill('Do you work?');
  await page.getByLabel('Label of option 1 (en)').fill('Yes');
  await expect(page.getByLabel('Label of option 1 (es)')).toHaveCount(0);
  await shot(page, 'designer-second-language');
  await page.getByLabel('Questionnaire language').selectOption('es');
  await expect(page.getByLabel('Question wording (es)')).toHaveValue('¿Trabaja usted?');
  // The section title has no English yet: the Spanish view says so.
  await outlineItem(page, 'SEC_A').click();
  await expect(page.getByText('Missing translation: en').first()).toBeVisible();
  await saved(page);
});

test('a questionnaire takes its modes at creation (Q1)', async ({ page }) => {
  await newQuestionnaire(page, 'Phone and web', ['CAPI', 'PAPI']);
  await page.goBack();
  const row = page.getByRole('row').filter({ hasText: 'Phone and web' });
  const chips = row.getByTestId('mode-chips');
  await expect(chips).toContainText('CATI');
  await expect(chips).toContainText('CAWI');
  await expect(chips).not.toContainText('CAPI');
  await expect(chips).not.toContainText('PAPI');

  // Its actions: paper forms are off (not a paper questionnaire), rename, then delete.
  await page.getByRole('button', { name: 'Actions for Phone and web' }).click();
  const menu = page.getByRole('menu', { name: 'Actions for Phone and web' });
  await expect(menu.getByRole('menuitem', { name: 'Paper forms' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  page.once('dialog', (d) => void d.accept('Phone and web (copy)'));
  await menu.getByRole('menuitem', { name: 'Rename…' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Phone and web (copy)' })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Phone and web (copy)' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.getByText('Deleted Phone and web (copy).')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Phone and web' })).toHaveCount(0);
});

test('the outline collapses to a rail whose pane opens over the editor, and pins back', async ({
  page,
}) => {
  await newQuestionnaire(page, 'Outline drawer');
  const tree = page.getByRole('tree', { name: 'Outline' });
  const editor = page.getByRole('region', { name: 'Item editor' });
  await page.getByRole('button', { name: 'Unpin: Outline' }).click();
  await expect(tree).toBeHidden();
  const rail = page.getByRole('button', { name: 'Outline', exact: true });
  await expect(rail).toHaveAttribute('aria-expanded', 'false');
  await shot(page, 'designer-outline-rail', { fullPage: false });
  const before = await editor.boundingBox();

  // Alt+O opens the pane over the editor (which does not move), focus on the current row.
  await page.keyboard.press('Alt+o');
  await expect(tree).toBeVisible();
  await expect(page.getByRole('treeitem', { selected: true })).toBeFocused();
  // It may grow (the first row gets selected), but it does not move.
  const after = await editor.boundingBox();
  expect({ x: after!.x, y: after!.y, width: after!.width }).toEqual({
    x: before!.x,
    y: before!.y,
    width: before!.width,
  });
  await shot(page, 'designer-outline-over', { fullPage: false });
  await expectAccessible(page);
  // Enter goes to the editor and the pane collapses.
  await outlineItem(page, 'SEC_A').focus();
  await page.keyboard.press('Enter');
  await expect(tree).toBeHidden();
  await expect(editor.locator(':focus')).toHaveCount(1);

  // Pointing at the rail opens it; moving away closes it.
  await rail.hover();
  await expect(tree).toBeVisible();
  await page.mouse.move(900, 600);
  await expect(tree).toBeHidden();
  // A click keeps it open until Escape.
  await rail.click();
  await page.mouse.move(900, 600);
  await expect(tree).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tree).toBeHidden();

  // Pinned again, it is a column beside the editor.
  await rail.click();
  await page.getByRole('button', { name: 'Keep open: Outline' }).click();
  await expect(tree).toBeVisible();
  await expect(rail).toHaveCount(0);
});

test('a failing saved scenario blocks publishing', async ({ page }) => {
  await newQuestionnaire(page, 'Scenario guard');
  await outlineItem(page, 'SEC_A').focus();
  await addWithKeyboard(page, 2); // Yes / No
  await page.getByLabel('Question wording (es)').fill('¿Adulto?');
  await outlineItem(page, 'A1').focus();
  await addWithKeyboard(page, 6); // Text
  await page.getByLabel('Question wording (es)').fill('¿Nombre?');
  await page.getByRole('tab', { name: 'Logic', exact: true }).click();
  await page.getByRole('button', { name: 'Add condition' }).first().click();
  await page.getByLabel('Condition 1: variable', { exact: true }).first().fill('A1');
  await page.getByLabel('Condition 1: value', { exact: true }).first().selectOption('1');
  await saved(page);

  // Save a run where "No" skips the name.
  await page.getByRole('tab', { name: 'Preview' }).click();
  await page.locator('[data-qkey="A1"]').focus();
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await expect(page.getByText('The interview is complete. Thank you.')).toBeVisible();
  await page.getByLabel('Scenario name').fill('No skips the name');
  await page.getByRole('button', { name: 'Save current run' }).click();
  await expect(page.getByTestId('scenarios')).toContainText('No skips the name');

  // Remove the show-if: the scenario now fails and publishing is blocked.
  await page.getByRole('tab', { name: 'Form' }).click();
  await outlineItem(page, 'A2').click();
  await page.getByRole('tab', { name: 'Logic', exact: true }).click();
  await page.getByRole('button', { name: 'Remove condition 1' }).first().click();
  await saved(page);
  await page.getByRole('button', { name: 'Publish…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish a new version' });
  await expect(dialog).toContainText('1 of 1 scenarios fails');
  await expect(dialog).toContainText('No skips the name');
  await expect(dialog.getByRole('button', { name: 'Publish version 1' })).toBeDisabled();
});

test('two editors: edits to different parts merge; the same edit asks which to keep', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const a = await browser.newPage();
  const url = await newQuestionnaire(a, 'Shared draft');
  const b = await browser.newPage();
  await login(b);
  await b.waitForURL((u) => !u.pathname.startsWith('/login'));
  await b.goto(url);
  await expect(b.getByRole('tree', { name: 'Outline' })).toBeVisible();

  // B retitles the questionnaire while A retitles the section: both survive.
  await openSettings(b, 'General');
  await shot(b, 'questionnaire-settings');
  await b.getByLabel('Title (es)').fill('Título compartido de B');
  await outlineItem(a, 'SEC_A').click();
  await a.getByLabel('Title (es)').fill('Sección de A');
  await saved(b);
  await saved(a);
  await openSettings(a, 'General');
  await expect(a.getByLabel('Title (es)')).toHaveValue('Título compartido de B', {
    timeout: 15_000,
  });
  await toDesign(b);
  await outlineItem(b, 'SEC_A').click();
  await expect(b.getByLabel('Title (es)')).toHaveValue('Sección de A', { timeout: 15_000 });
  await expect(a.getByRole('dialog')).toHaveCount(0);
  await shot(a, 'designer-merged');

  // Both rename the questionnaire: whoever saves second is asked.
  await b.getByLabel('Questionnaire name').fill('Shared draft (B)');
  await a.getByLabel('Questionnaire name').fill('Shared draft (A)');
  const title = 'Someone else changed this questionnaire';
  await expect
    .poll(
      async () =>
        (await a.getByRole('dialog', { name: title }).count()) +
        (await b.getByRole('dialog', { name: title }).count()),
      { timeout: 15_000 },
    )
    .toBe(1);
  const asked = (await a.getByRole('dialog', { name: title }).count()) ? a : b;
  const other = asked === a ? 'Shared draft (B)' : 'Shared draft (A)';
  const dialog = asked.getByRole('dialog', { name: title });
  await expect(dialog.getByTestId('conflict-items')).toContainText('name');
  await shot(asked, 'designer-conflict');
  await dialog.getByRole('button', { name: 'Discard mine and load theirs' }).click();
  await expect(asked.getByLabel('Questionnaire name')).toHaveValue(other);
  await expect(dialog).toBeHidden();
});

test('reviewers comment, editors see who is here, and items go to and from the library', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const pm = await browser.newPage();
  const url = await newQuestionnaire(pm, 'Review round');
  await outlineItem(pm, 'SEC_A').focus();
  await addWithKeyboard(pm, 0); // Single choice
  await rename(pm, 'A_CONSENT');
  await pm.getByLabel('Question wording (es)').fill('¿Acepta participar?');
  await saved(pm);

  // A supervisor opens it: the editor sees them, on the item they look at.
  const sup = await browser.newPage();
  await login(sup, 'supervisor@demo.wansurvey.test');
  await sup.waitForURL((u) => !u.pathname.startsWith('/login'));
  await sup.goto(url);
  await outlineItem(sup, 'A_CONSENT').click();
  await expect(pm.getByTestId('presence')).toContainText('Demo supervisor', { timeout: 15_000 });
  await expect(outlineItem(pm, 'A_CONSENT').getByTestId('presence-marker')).toBeVisible();

  // The supervisor cannot edit but can comment.
  await expect(sup.getByLabel('Question wording (es)')).toBeDisabled();
  const comments = sup.getByTestId('comments');
  await comments.getByLabel('Add a comment').fill('Please add a "Prefer not to say" option.');
  await comments.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(comments.locator('[data-thread]')).toContainText('Prefer not to say');
  await expectAccessible(sup);

  await pm.reload();
  await expect(outlineItem(pm, 'A_CONSENT').getByTestId('comment-badge')).toContainText('1');
  await outlineItem(pm, 'A_CONSENT').click();
  const thread = pm.getByTestId('comments').locator('[data-thread]');
  await thread.getByRole('button', { name: 'Reply' }).click();
  await thread.getByLabel(/Reply to/).fill('Done.');
  await thread.getByRole('button', { name: 'Reply' }).click();
  await expect(thread).toContainText('Done.');
  await shot(pm, 'designer-comments');
  await thread.getByRole('button', { name: 'Resolve' }).click();
  await expect(outlineItem(pm, 'A_CONSENT').getByTestId('comment-badge')).toHaveCount(0);

  // Save the question to the library, then insert it again: it gets a fresh name.
  await pm.getByRole('button', { name: 'Save to library' }).click();
  const save = pm.getByRole('dialog', { name: /Save A_CONSENT to the question library/ });
  await save.getByLabel('Name').fill('Consent question');
  await save.getByLabel('Tags (comma separated)').fill('consent, core');
  await save.getByRole('button', { name: 'Save to library' }).click();
  await expect(pm.getByTestId('presence')).toContainText('Saved to the library.');
  // The row's context menu (right click) offers the library too.
  await outlineItem(pm, 'A_CONSENT').click({ button: 'right' });
  const rowMenu = pm.getByRole('menu', { name: 'Actions for A_CONSENT' });
  await expect(rowMenu.getByRole('menuitem', { name: /Duplicate/ })).toBeVisible();
  await rowMenu.getByRole('menuitem', { name: /From the library/ }).click();
  const lib = pm.getByRole('dialog', { name: 'Insert from the question library' });
  await lib.getByLabel('Search the library').fill('Consent');
  await lib
    .getByRole('button', { name: /Consent question/ })
    .first()
    .click();
  await expect(lib.getByTestId('library-preview')).toContainText('¿Acepta participar?');
  await shot(pm, 'designer-library');
  await expectAccessible(pm, 'dialog');
  await lib.getByRole('button', { name: 'Insert Consent question' }).click();
  await expect(outlineItem(pm, 'A_CONSENT_2')).toBeVisible();
  await expect(pm.getByTestId('presence')).toContainText('A_CONSENT → A_CONSENT_2');
  await saved(pm);

  // Entries can be removed from the library; questionnaires keep their copy.
  await outlineItem(pm, 'A_CONSENT_2').click({ button: 'right' });
  await pm.getByRole('menuitem', { name: /From the library/ }).click();
  await lib.getByLabel('Search the library').fill('Consent question');
  await expect(lib.getByTestId('library-preview')).toContainText('Consent question');
  pm.once('dialog', (d) => void d.accept());
  await lib.getByRole('button', { name: 'Remove from library' }).click();
  await expect(lib.getByRole('status')).toContainText('Removed Consent question from the library.');
  await expect(outlineItem(pm, 'A_CONSENT_2')).toBeVisible();
});

test('the routing map, outline arcs and nested condition builder on the household survey', async ({
  page,
}) => {
  await login(page);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByRole('link', { name: 'Household Survey 2026' }).click();
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();
  await page.getByRole('link', { name: 'Household questionnaire' }).click();
  await expect(page.getByRole('tree', { name: 'Outline' })).toBeVisible();

  // Outline: badges and skip arcs.
  await expect(page.getByTestId('logic-badges').first()).toBeVisible();
  await expect(page.getByTestId('outline-arcs').locator('path').first()).toBeVisible();
  await shot(page, 'designer-outline-arcs');

  // Routing map.
  await page.getByRole('tab', { name: 'Routing' }).click();
  const map = page.getByTestId('routing-map');
  await expect(map).toContainText('Skips to');
  await expect(map).toContainText('Ends as');
  await expect(page.locator('path[data-arc]').first()).toBeVisible();
  await shot(page, 'designer-routing-map');
  await expectAccessible(page);
  const card = map.getByTestId('routing-card').filter({ hasText: 'Asked only if' }).first();
  const id = (await card.getAttribute('data-card'))!;
  // A click previews the item (options, script) without leaving the map.
  await card.getByRole('button').last().click();
  const preview = card.getByTestId('routing-preview');
  await expect(preview).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Routing' })).toHaveAttribute('aria-selected', 'true');
  await expectAccessible(page);

  // The logic check is a button here; its bubble can mark the items with problems.
  await page.getByRole('button', { name: 'Check the logic' }).click();
  await expect(page.getByTestId('logic-check')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('logic-check')).toBeHidden();

  // Its button opens the item in the editor.
  await preview.getByRole('button', { name: 'Edit this item' }).click();
  await expect(page.getByRole('tab', { name: 'Form' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('treeitem', { selected: true })).toHaveAttribute('data-id', id);

  // Nested condition builder with a plain-language summary and a live test.
  await page.getByRole('tab', { name: 'Logic', exact: true }).click();
  const showIf = page.getByRole('group', { name: 'Show only if' });
  await expect(showIf.getByTestId('condition-summary')).not.toContainText('Always');
  await showIf.getByRole('button', { name: 'Add group' }).click();
  await expect(showIf.getByTestId('condition-group')).toBeVisible();
  await showIf.getByText('Try it with sample answers').click();
  await expect(showIf.getByTestId('try-result')).toBeVisible();
  await shot(page, 'designer-condition-builder');
  await expectAccessible(page);
});
