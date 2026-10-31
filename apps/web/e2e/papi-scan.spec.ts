import { expect, test } from '@playwright/test';
import { connectDb } from './db.js';
import { uuidv7 } from 'uuidv7';
import { expectAccessible, login, pickOrganisation, questionnaireAction, shot } from './helpers.js';

const CLERK = 'data.entry@demo.wansurvey.test';

test('scanned forms: a PDF with two forms is split and read, and the clerk finishes one by hand', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const db = connectDb();
  try {
    // Two cases of their own for the household questionnaire.
    const [q] = await db.all(
      `select q.id, q.project_id, q.tenant_id from questionnaires q
       join projects p on p.id = q.project_id
       where q.name = 'Household questionnaire' and p.name = 'Household Survey 2026'`,
    );
    const ids: string[] = [];
    for (const ext of ['SCAN-A', 'SCAN-B']) {
      const id = uuidv7();
      ids.push(id);
      await db.run(
        `insert into cases (id, tenant_id, project_id, questionnaire_id, external_id, sample, status)
         values (?, ?, ?, ?, ?, ?::text::jsonb, 'fresh')`,
        [id, q!.tenant_id, q!.project_id, q!.id, ext, JSON.stringify({ city: 'Lima' })],
        `insert into cases (id, tenant_id, project_id, questionnaire_id, external_id, sample, status)
         values (?, ?, ?, ?, ?, ?, 'fresh')`,
      );
    }

    await login(page);
    await pickOrganisation(page, 'Demo Research');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Projects', exact: true })
      .click();
    await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
    await questionnaireAction(page, 'Paper forms');
    await expect(page.getByTestId('scan-forms-pdf')).toBeVisible();

    // The forms to print, then "scanned" as they are: one PDF with both.
    const pdf = await page.request.get(
      `/api/v1/projects/${q!.project_id}/papi/scan-forms.pdf?questionnaireId=${q!.id}&caseIds=${ids.join(',')}`,
    );
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    const scans = page.getByTestId('scans');
    await scans.getByLabel('PDF files').setInputFiles({
      name: 'escaneo-lote-1.pdf',
      mimeType: 'application/pdf',
      buffer: await pdf.body(),
    });
    await scans.getByRole('button', { name: 'Upload and read' }).click();
    const batch = scans.locator('[data-batch="escaneo-lote-1.pdf"]');
    await expect(batch.getByTestId('batch-status')).toHaveText('Read', { timeout: 60_000 });
    await expect(batch.locator('tr[data-form="SCAN-A"]')).toContainText('Second round');
    await expect(batch.locator('tr[data-form="SCAN-B"]')).toBeVisible();
    await shot(page, 'papi-scans');
    await expectAccessible(page);

    // The clerk takes SCAN-A: the keying screen shows where each question is on the scan.
    const clerk = await (
      await browser.newContext({ storageState: './e2e/english-ui.json' })
    ).newPage();
    await login(clerk, CLERK);
    await pickOrganisation(clerk, 'Demo Research');
    await clerk
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Projects', exact: true })
      .click();
    await clerk.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
    await questionnaireAction(clerk, 'Paper forms');
    await clerk
      .getByTestId('scans')
      .locator('[data-batch="escaneo-lote-1.pdf"]')
      .getByRole('button', { name: 'Complete form SCAN-A' })
      .click();
    await expect(clerk.getByRole('heading', { name: /Case SCAN-A/ })).toBeVisible();
    const panel = clerk.getByTestId('scan-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('img').first()).toBeVisible();
    await shot(clerk, 'papi-scan-second-round');
    await expectAccessible(clerk);
  } finally {
    await db.end();
  }
});
