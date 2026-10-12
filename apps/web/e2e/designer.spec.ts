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
async function newQuestionnaire(page: Page, name: string) {
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
  await newQuestionnaire(page, 'Work module');
  // The outline starts on the first section.
  const section = outlineItem(page, 'SEC_A');
  await section.focus();
  await addWithKeyboard(page, 0); // Single choice, inside the section
  await expect(outlineItem(page, 'Q1')).toBeFocused();
  await rename(page, 'WORK');
  await page.getByLabel('Question wording (en)').fill('Do you work?');
  await page.getByLabel('Question wording (es)').fill('¿Trabaja?');
  await page.getByLabel('Label of option 1 (en)').fill('Yes');
  await page.getByLabel('Label of option 1 (es)').fill('Sí');
  await page.getByLabel('Label of option 2 (en)').fill('No');
  await page.getByLabel('Label of option 2 (es)').fill('No');

  await outlineItem(page, 'WORK').focus();
  await addWithKeyboard(page, 2); // Number
  await rename(page, 'HOURS');
  await page.getByLabel('Question wording (en)').fill('How many hours a week?');
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
});

test('a failing saved scenario blocks publishing', async ({ page }) => {
  await newQuestionnaire(page, 'Scenario guard');
  await outlineItem(page, 'SEC_A').focus();
  await addWithKeyboard(page, 10); // Yes / No
  await page.getByLabel('Question wording (en)').fill('Adult?');
  await page.getByLabel('Question wording (es)').fill('¿Adulto?');
  await outlineItem(page, 'Q1').focus();
  await addWithKeyboard(page, 3); // Text
  await page.getByLabel('Question wording (en)').fill('Name?');
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

test('a second editor saving first gets a conflict dialog, not a silent overwrite', async ({
  browser,
}) => {
  const a = await browser.newPage();
  const url = await newQuestionnaire(a, 'Shared draft');
  const b = await browser.newPage();
  await login(b);
  await b.waitForURL((u) => !u.pathname.startsWith('/login'));
  await b.goto(url);
  await expect(b.getByRole('tree', { name: 'Outline' })).toBeVisible();

  await b.getByLabel('Questionnaire name').fill('Shared draft (B)');
  await saved(b);

  await a.getByLabel('Questionnaire name').fill('Shared draft (A)');
  const dialog = a.getByRole('dialog', { name: 'Someone else changed this questionnaire' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await shot(a, 'designer-conflict');
  await dialog.getByRole('button', { name: 'Discard mine and load theirs' }).click();
  await expect(a.getByLabel('Questionnaire name')).toHaveValue('Shared draft (B)');
  await expect(dialog).toBeHidden();
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
