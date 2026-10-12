import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, login, shot } from './helpers.js';

async function openPreview(page: Page) {
  await login(page);
  await page.getByRole('link', { name: 'Questionnaire preview' }).click();
  await expect(page.getByRole('heading', { name: 'Questionnaire preview' })).toBeVisible();
  await expect(page.locator('[data-qkey="A0_CONSENT_TEXT"]')).toBeFocused();
}

const current = (page: Page) => page.locator('[data-qkey]').first();
const press = async (page: Page, ...keys: string[]) => {
  for (const k of keys) await page.keyboard.press(k);
};
const typeAndEnter = async (page: Page, text: string) => {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

test('a CATI interviewer completes the household survey with the keyboard only', async ({
  page,
}) => {
  await openPreview(page);
  await shot(page, 'preview-cati-start');
  await press(page, 'Enter'); // consent text
  await typeAndEnter(page, '1'); // A1 consent: Yes
  await expect(current(page)).toContainText('Could you tell me your age, please?');
  await typeAndEnter(page, '40'); // A2
  await typeAndEnter(page, '2'); // A3 sex
  await typeAndEnter(page, '1'); // A4 married
  await expect(current(page)).toContainText('your husband');
  await typeAndEnter(page, 'Pat'); // A4 spouse
  await typeAndEnter(page, 'Rosa'); // A5 name
  await expect(current(page)).toContainText('Rosa, how many people live in this household');
  await typeAndEnter(page, '3'); // B1
  await typeAndEnter(page, '1'); // B2 children
  await typeAndEnter(page, '1'); // B2 school kids
  for (const m of [
    ['Rosa', '40', '2', '1', '1000'],
    ['Pat', '42', '1', '2'],
  ]) {
    for (const v of m) await typeAndEnter(page, v);
  }
  await typeAndEnter(page, 'Kid');
  await typeAndEnter(page, '3'); // under 5: rest of the row skipped
  await expect(current(page)).toContainText('Total household income: 1000');
  await press(page, 'Enter');
  for (const v of ['2', '300', '4', '1', '1']) await typeAndEnter(page, v); // C1 rented, rent, rooms, piped, electricity
  await press(page, '1', '2', 'Enter'); // C7 appliances: TV + fridge
  await typeAndEnter(page, '5'); // C8 fridge age
  for (const v of ['1', '2', '2']) await typeAndEnter(page, v); // D1, D2, D3
  await page.keyboard.type('09012026'); // D4 date (mm dd yyyy in en-US)
  await press(page, 'Enter');
  await typeAndEnter(page, '9'); // D5 NPS
  await press(page, 'Space', 'Tab', 'Space', 'Tab', 'Space', 'Enter'); // D6 grid, one code per row
  await typeAndEnter(page, '1'); // E1 recontact
  await typeAndEnter(page, '5551234'); // E2 phone
  await typeAndEnter(page, '3'); // E3 any time → skip to region
  await expect(current(page)).toContainText('Region (confirm)');
  await press(page, 'Enter'); // E5 prefilled from case data
  await press(page, 'Enter'); // E6 comments are optional
  await expect(page.getByText('The interview is complete. Thank you.')).toBeVisible();

  const tracer = page.getByTestId('tracer');
  await expect(tracer.locator('[data-key="HH[3].M_SEX"]')).toHaveAttribute(
    'data-status',
    'skipped',
  );
  await expect(tracer.locator('[data-key="C5_DIST"]')).toHaveAttribute('data-status', 'skipped');
  await page.getByRole('tab', { name: 'Answers' }).click();
  await expect(page.getByTestId('answers-json')).toContainText('"TOTAL_INCOME": 1000');
});

test('changing an earlier answer clears later ones, announces it, and the tracer shows why', async ({
  page,
}) => {
  await openPreview(page);
  await press(page, 'Enter');
  for (const v of ['1', '40', '2', '1', 'Pat']) await typeAndEnter(page, v);
  await press(page, 'Shift+Enter', 'Shift+Enter');
  await expect(current(page)).toContainText('What is your marital status?');
  await press(page, '2');
  await expect(page.getByRole('status')).toContainText(
    'removed 1 later answer that no longer applies: A4_SPOUSE',
  );
  const spouse = page.getByTestId('tracer').locator('[data-key="A4_SPOUSE"]');
  await expect(spouse).toHaveAttribute('data-status', 'skipped');
  await expect(spouse).toContainText('Skipped by rule on A4_MARITAL');
  await expectAccessible(page, 'main');
});

test('respondents on a phone get one question per page; PAPI prints routing as instructions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPreview(page);
  await page.getByTestId('mode').selectOption('CAWI');
  await expect(page.locator('[data-qkey]')).toHaveCount(1);
  // No sideways scrolling at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator('[data-qkey]')).toContainText(
    'Hello Rosa, we are conducting a survey in Lima.',
  );
  await page.getByRole('button', { name: /Next/ }).click();
  await expect(page.locator('[data-qkey]')).toContainText('Do you agree to take part?');
  await page.getByLabel('Yes').check();
  await page.getByRole('button', { name: /Next/ }).click();
  await expect(page.locator('[data-qkey]')).toContainText('How old are you?');
  await shot(page, 'preview-cawi-phone');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId('mode').selectOption('PAPI');
  await expect(page.getByText('If Q4 is not “Married” (1) → go to Q6')).toBeVisible();
  await expect(page.getByText('If Q1 is “No” (2) → end the interview (REFUSAL)')).toBeVisible();
  await shot(page, 'preview-papi');
});

test('the preview flags questionnaire problems and runs saved scenarios', async ({ page }) => {
  await openPreview(page);
  await press(page, 'Enter');
  for (const v of ['1', '16']) await typeAndEnter(page, v); // screened out
  await expect(page.getByText('The interview has ended (SCREENED_OUT).')).toBeVisible();
  await page.getByLabel('Scenario name').fill('Under 18 is screened out');
  await page.getByRole('button', { name: 'Save current run' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('scenarios').locator('[data-result]')).toHaveAttribute(
    'data-result',
    'passed',
  );

  await page.locator('summary', { hasText: 'Paste JSON' }).click();
  await page.getByLabel('Paste JSON').fill(
    JSON.stringify({
      id: 'BROKEN',
      title: { en: 'Broken' },
      defaultLanguage: 'en',
      languages: ['en'],
      sections: [
        {
          id: 'S',
          title: { en: 'S' },
          items: [
            {
              kind: 'question',
              id: 'A',
              name: 'A',
              type: 'numeric',
              text: { en: 'A' },
              showIf: 'NOPE > 1',
            },
          ],
        },
      ],
    }),
  );
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.getByText('1 error blocks publishing')).toBeVisible();
  await expect(page.getByText("Unknown variable 'NOPE'")).toBeVisible();
});
