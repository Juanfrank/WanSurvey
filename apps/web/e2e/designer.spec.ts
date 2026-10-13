import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, login, shot } from './helpers.js';

const outlineItem = (page: Page, name: string) =>
  page.getByRole('treeitem').filter({ has: page.locator(`span.font-mono:text-is("${name}")`) });

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved', {
    timeout: 10_000,
  });
}

/** Creates a blank questionnaire in the demo project and opens it in the designer. */
async function newQuestionnaire(page: Page, name: string, untick: string[] = []) {
  await login(page);
  // Other specs switch organisation, and the last one used opens by default.
  const org = page.getByRole('combobox', { name: 'Organisation' });
  await expect(org).toBeVisible();
  if (
    (await org.inputValue()) !==
    (await org.locator('option', { hasText: 'Demo Research' }).getAttribute('value'))
  )
    await org.selectOption({ label: 'Demo Research' });
  await expect(org.locator('option:checked')).toHaveText('Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByRole('link', { name: 'Household Survey 2026' }).click();
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

/** Adds an item after the focused outline row with the keyboard: Insert, arrows, Enter. */
async function addWithKeyboard(page: Page, steps: number) {
  await page.keyboard.press('Insert');
  await expect(page.getByRole('group', { name: 'Choose what to add' })).toBeVisible();
  for (let i = 0; i < steps; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

async function rename(page: Page, name: string) {
  await page.keyboard.press('F2');
  const field = page.getByLabel('Variable name');
  await expect(field).toBeFocused();
  await field.fill(name);
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
  await expect(outlineItem(page, 'Q1')).toBeFocused();
  await rename(page, 'WORK');
  await page.getByLabel('Question wording (es)').fill('¿Trabaja?');
  await page.getByLabel('Label of option 1 (es)').fill('Sí');
  await page.getByLabel('Label of option 2 (es)').fill('No');

  await outlineItem(page, 'WORK').focus();
  await addWithKeyboard(page, 2); // Number
  await rename(page, 'HOURS');
  await page.getByLabel('Question wording (es)').fill('¿Cuántas horas por semana?');

  // Skip HOURS when WORK is No, built with the condition rows.
  await outlineItem(page, 'WORK').click();
  await page.getByRole('tab', { name: 'Logic', exact: true }).click();
  await page.getByRole('button', { name: 'Add skip' }).click();
  await page.getByLabel('Condition 1: value', { exact: true }).first().selectOption('2');
  await page.getByLabel('Skip 1: go to').selectOption('END');
  await expect(page.getByTestId('skip-rule')).toContainText('No');
  await saved(page);
  await shot(page, 'designer-logic');
  await expectAccessible(page);

  // Reordering with Alt+arrows and undo.
  await outlineItem(page, 'HOURS').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByRole('treeitem').nth(2)).toContainText('HOURS');
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('treeitem').nth(2)).toContainText('WORK');

  // Preview: WORK = No ends the interview without HOURS.
  await page.getByRole('tab', { name: 'Preview' }).click();
  await page.locator('[data-qkey="WORK"]').focus();
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await expect(page.getByText('The interview is complete. Thank you.')).toBeVisible();
  await expect(page.getByTestId('tracer').locator('[data-key="HOURS"]')).toHaveAttribute(
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
  await page.getByRole('tab', { name: 'Design' }).click();
  await outlineItem(page, 'WORK').click();
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

  // Compare: the draft equals v2; v1 differs in WORK's codes.
  const compare = page.getByTestId('compare');
  await expect(compare.getByTestId('compare-summary')).toHaveText('No differences.');
  await compare.getByLabel('Compare').selectOption({ label: 'v1' });
  await expect(compare.locator('[data-compare-item="WORK"]')).toContainText('Edited');
  await expect(compare.locator('[data-compare-item="WORK"]')).toContainText('options[3].code');
  await shot(page, 'designer-compare');
  await expectAccessible(page);

  // Drag HOURS above WORK in the outline; the comparison with v2 shows the move.
  await page.getByRole('tab', { name: 'Design' }).click();
  await outlineItem(page, 'HOURS').dragTo(outlineItem(page, 'WORK'), {
    targetPosition: { x: 20, y: 2 },
  });
  await expect(page.getByRole('treeitem').nth(2)).toContainText('HOURS');
  await saved(page);
  await page.getByRole('tab', { name: 'Versions' }).click();
  await compare.getByLabel('Compare').selectOption({ label: 'v2' });
  await expect(compare.getByTestId('compare-summary')).toHaveText(
    '0 added · 0 removed · 0 edited · 1 moved',
  );

  // Translations: export the CSV, change a Spanish text, import it back.
  await page.getByRole('tab', { name: 'Design' }).click();
  await page.getByRole('treeitem', { name: /Questionnaire settings/ }).click();
  const [csvFile] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export all texts (CSV)' }).click(),
  ]);
  const csv = readFileSync((await csvFile.path())!, 'utf8');
  expect(csv).toContain('WORK.text');
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
  await outlineItem(page, 'WORK').click();
  await expect(page.getByLabel('Question wording (es)')).toHaveValue('¿Trabaja usted?');
  await saved(page);

  // Another language is added as such and edited on its own, one language at a time.
  await page.getByRole('treeitem', { name: /Questionnaire settings/ }).click();
  const newLang = page.getByLabel('Add language');
  await newLang.fill('en');
  await newLang.locator('xpath=following::button[1]').click();
  await page.getByLabel('Questionnaire language').selectOption('en');
  await outlineItem(page, 'WORK').click();
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
});

test('a failing saved scenario blocks publishing', async ({ page }) => {
  await newQuestionnaire(page, 'Scenario guard');
  await outlineItem(page, 'SEC_A').focus();
  await addWithKeyboard(page, 10); // Yes / No
  await page.getByLabel('Question wording (es)').fill('¿Adulto?');
  await outlineItem(page, 'Q1').focus();
  await addWithKeyboard(page, 3); // Text
  await page.getByLabel('Question wording (es)').fill('¿Nombre?');
  await page.getByRole('tab', { name: 'Logic', exact: true }).click();
  await page.getByRole('button', { name: 'Add condition' }).first().click();
  await page.getByLabel('Condition 1: variable', { exact: true }).first().fill('Q1');
  await page.getByLabel('Condition 1: value', { exact: true }).first().selectOption('1');
  await saved(page);

  // Save a run where "No" skips the name.
  await page.getByRole('tab', { name: 'Preview' }).click();
  await page.locator('[data-qkey="Q1"]').focus();
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await expect(page.getByText('The interview is complete. Thank you.')).toBeVisible();
  await page.getByLabel('Scenario name').fill('No skips the name');
  await page.getByRole('button', { name: 'Save current run' }).click();
  await expect(page.getByTestId('scenarios')).toContainText('No skips the name');

  // Remove the show-if: the scenario now fails and publishing is blocked.
  await page.getByRole('tab', { name: 'Design' }).click();
  await outlineItem(page, 'Q2').click();
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
  await b.getByRole('treeitem', { name: /Questionnaire settings/ }).click();
  await b.getByLabel('Title (es)').fill('Título compartido de B');
  await outlineItem(a, 'SEC_A').click();
  await a.getByLabel('Title (es)').fill('Sección de A');
  await saved(b);
  await saved(a);
  await a.getByRole('treeitem', { name: /Questionnaire settings/ }).click();
  await expect(a.getByLabel('Title (es)')).toHaveValue('Título compartido de B', {
    timeout: 15_000,
  });
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
  await rename(pm, 'CONSENT');
  await pm.getByLabel('Question wording (es)').fill('¿Acepta participar?');
  await saved(pm);

  // A supervisor opens it: the editor sees them, on the item they look at.
  const sup = await browser.newPage();
  await login(sup, 'supervisor@demo.wansurvey.test');
  await sup.waitForURL((u) => !u.pathname.startsWith('/login'));
  await sup.goto(url);
  await outlineItem(sup, 'CONSENT').click();
  await expect(pm.getByTestId('presence')).toContainText('Demo supervisor', { timeout: 15_000 });
  await expect(outlineItem(pm, 'CONSENT').getByTestId('presence-marker')).toBeVisible();

  // The supervisor cannot edit but can comment.
  await expect(sup.getByLabel('Question wording (es)')).toBeDisabled();
  const comments = sup.getByTestId('comments');
  await comments.getByLabel('Add a comment').fill('Please add a "Prefer not to say" option.');
  await comments.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(comments.locator('[data-thread]')).toContainText('Prefer not to say');
  await expectAccessible(sup);

  await pm.reload();
  await expect(outlineItem(pm, 'CONSENT').getByTestId('comment-badge')).toContainText('1');
  await outlineItem(pm, 'CONSENT').click();
  const thread = pm.getByTestId('comments').locator('[data-thread]');
  await thread.getByRole('button', { name: 'Reply' }).click();
  await thread.getByLabel(/Reply to/).fill('Done.');
  await thread.getByRole('button', { name: 'Reply' }).click();
  await expect(thread).toContainText('Done.');
  await shot(pm, 'designer-comments');
  await thread.getByRole('button', { name: 'Resolve' }).click();
  await expect(outlineItem(pm, 'CONSENT').getByTestId('comment-badge')).toHaveCount(0);

  // Save the question to the library, then insert it again: it gets a fresh name.
  await pm.getByRole('button', { name: 'Save to library' }).click();
  const save = pm.getByRole('dialog', { name: /Save CONSENT to the question library/ });
  await save.getByLabel('Name').fill('Consent question');
  await save.getByLabel('Tags (comma separated)').fill('consent, core');
  await save.getByRole('button', { name: 'Save to library' }).click();
  await expect(pm.getByTestId('presence')).toContainText('Saved to the library.');
  await outlineItem(pm, 'CONSENT').focus();
  await pm.keyboard.press('Insert');
  await pm.getByRole('button', { name: 'From the library…' }).click();
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
  await expect(outlineItem(pm, 'CONSENT_2')).toBeVisible();
  await expect(pm.getByTestId('presence')).toContainText('CONSENT → CONSENT_2');
  await saved(pm);
});

test('the routing map, outline arcs and nested condition builder on the household survey', async ({
  page,
}) => {
  await login(page);
  const org = page.getByRole('combobox', { name: 'Organisation' });
  await expect(org).toBeVisible();
  if ((await org.locator('option:checked').textContent()) !== 'Demo Research')
    await org.selectOption({ label: 'Demo Research' });
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await page.getByRole('link', { name: 'Household Survey 2026' }).click();
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
  await card.getByRole('button').last().click();
  await expect(page.getByRole('tab', { name: 'Design' })).toHaveAttribute('aria-selected', 'true');
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
