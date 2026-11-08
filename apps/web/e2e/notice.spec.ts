import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, login, pickOrganisation, shot } from './helpers.js';

const outlineItem = (page: Page, name: string) =>
  page.getByRole('treeitem').filter({ has: page.locator(`span.font-mono:text-is("${name}")`) });

test('the information notice is part of the questionnaire: added from the designer, required by the project', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  await pickOrganisation(page, 'Demo Research');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();

  // The project asks every questionnaire to open with the notice.
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Privacy', exact: true }).click();
  await page
    .getByLabel('Do not publish a questionnaire that does not open with the information notice')
    .check();
  await page
    .getByLabel('Exclude people under this age (the questionnaire must screen by age):')
    .check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible();
  await shot(page, 'settings-notice', { fullPage: true });

  // A new questionnaire: the button adds the standard pair at the start.
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();
  await page.getByLabel('Questionnaire name').fill('Con aviso');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.getByRole('tree', { name: 'Outline' })).toBeVisible();
  await page
    .getByRole('button', { name: 'Add the information notice at the start of the questionnaire' })
    .click();
  await expect(outlineItem(page, 'NOTICE_TEXT')).toBeVisible();
  await expect(outlineItem(page, 'NOTICE_ACCEPT')).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Add the information notice at the start of the questionnaire',
    }),
  ).toHaveCount(0);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved', {
    timeout: 10_000,
  });
  // The project sets a minimum age: the outline offers the age screen after the notice.
  await page
    .getByRole('button', { name: 'Add the age screen: under 18 the interview ends' })
    .click();
  await expect(outlineItem(page, 'AGE_SCREEN')).toBeVisible();
  // A question marked as sensitive is personal data too.
  await outlineItem(page, 'NOTICE_ACCEPT').click();
  await page.getByLabel('Sensitive data (special category)').selectOption({ label: 'Health' });
  await expect(page.getByRole('checkbox', { name: 'Personal data' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Personal data' })).toBeDisabled();
  await page
    .getByLabel('Sensitive data (special category)')
    .selectOption({ label: 'Not sensitive' });
  await shot(page, 'designer-notice', { fullPage: false });
  await expectAccessible(page);

  // Back as it was for the other tests.
  await page.getByRole('link', { name: 'Household Survey 2026' }).first().click();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Privacy', exact: true }).click();
  await page
    .getByLabel('Do not publish a questionnaire that does not open with the information notice')
    .uncheck();
  await page
    .getByLabel('Exclude people under this age (the questionnaire must screen by age):')
    .uncheck();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible();
});
