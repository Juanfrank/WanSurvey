import { expect, test, type Page } from './fixtures.js';
import { totp } from '../../api/dist/common/crypto.js';
import { connectDb } from './db.js';
import { expectAccessible, login, shot } from './helpers.js';

const ADMIN = 'admin@demo.wansurvey.test';

/** A logo drawn in the page (a canvas as PNG), so the picture shows something like a real one. */
async function drawLogo(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 96;
    const g = c.getContext('2d')!;
    g.fillStyle = '#7a1f5c';
    g.beginPath();
    g.arc(48, 48, 40, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = 'bold 40px sans-serif';
    g.fillText('ID', 26, 62);
    g.fillStyle = '#7a1f5c';
    g.font = 'bold 34px sans-serif';
    g.fillText('Instituto Demo', 100, 60);
    return c.toDataURL('image/png');
  });
  return Buffer.from(url.split(',')[1]!, 'base64');
}

test('the organisation’s colours and logo, with WanSurvey as a sub-logo', async ({ page }) => {
  test.setTimeout(120_000);
  // The administrator enrols a second factor on sign-in (as in the team and hardening tests),
  // and the organisation's look is put back as it was, whatever happens.
  const db = connectDb();
  const reset2fa = () =>
    db.run(
      'UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE email = ?',
      [ADMIN],
    );
  const [{ id: tenantId, branding }] = (await db.all(
    "SELECT id, branding FROM tenants WHERE name = 'Demo Research'",
  )) as [{ id: string; branding: string }];
  try {
    await reset2fa();
    await login(page, ADMIN);
    await page.waitForURL(/\/login\/2fa\/setup/);
    const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
    await page.getByLabel('Code').fill(totp(secret));
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
    await page.goto('/admin/organisation');
    const form = page.getByTestId('org-appearance');
    const preview = page.getByTestId('theme-preview');
    await expect(form).toBeVisible();

    // The main colour of the organisation's own: the preview follows at once.
    await form.getByRole('radio', { name: 'Own colour', exact: true }).check();
    const primary = form.getByRole('textbox', { name: 'Own main colour', exact: true });
    // A colour white text cannot be read on is made darker, and the page says so.
    await primary.fill('#ffd400');
    await expect(form.getByTestId('primary-adjusted')).toContainText('#806a00');
    await expect(preview.getByTestId('preview-button')).toHaveCSS(
      'background-color',
      'rgb(128, 106, 0)',
    );
    // Not a colour: said, and nothing is saved.
    await primary.fill('#7a1f5');
    await expect(form.getByText('Write the colour as #rrggbb')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await primary.fill('#7a1f5c');
    await expect(form.getByTestId('primary-adjusted')).toHaveCount(0);
    await expect(preview.getByTestId('preview-button')).toHaveCSS(
      'background-color',
      'rgb(122, 31, 92)',
    );

    // A side panel whose text cannot be read is not saved.
    await form.getByRole('radio', { name: 'Own colours', exact: true }).check();
    await form.getByRole('textbox', { name: 'Background', exact: true }).fill('#ffffff');
    await form.getByRole('textbox', { name: 'Text', exact: true }).fill('#eeeeee');
    await expect(form.getByTestId('theme-problems')).toContainText('side panel');
    await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await form.getByRole('textbox', { name: 'Text', exact: true }).fill('#20263a');
    await expect(form.getByTestId('theme-problems')).toHaveCount(0);
    await form.getByRole('radio', { name: 'Standard', exact: true }).check();

    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form.getByText('Appearance saved.')).toBeVisible();
    // The whole interface takes it: the buttons and the open page in the side panel (the pointer
    // moved off the button, which is lighter while hovered).
    await page.mouse.move(0, 0);
    await expect(form.getByRole('button', { name: 'Save', exact: true })).toHaveCSS(
      'background-color',
      'rgb(122, 31, 92)',
    );
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Administration', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('style', /--color-indigo-600: #7a1f5c/);

    // The logo: its description first, then the image; WanSurvey becomes the sub-logo.
    const choose = form.getByLabel('Choose the logo image');
    await form.getByRole('button', { name: 'Upload logo' }).click();
    await expect(form.getByText('Write the logo description first.')).toBeVisible();
    await form.getByLabel('Logo description').fill('Instituto Demo');
    await choose.setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: await drawLogo(page),
    });
    await expect(form.getByText('Logo saved.')).toBeVisible();
    await form.getByRole('radio', { name: 'Sub-logo' }).check();
    await expect(preview.getByTestId('preview-logo').locator('img')).toHaveCount(1);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form.getByText('Appearance saved.')).toBeVisible();

    const side = page.getByTestId('side-logo');
    await expect(side).toHaveAttribute('data-place', 'sub');
    await expect(side.getByRole('img', { name: 'Instituto Demo' })).toBeVisible();
    await expect(page.getByRole('banner').getByTestId('app-sublogo')).toContainText('WanSurvey');
    // The link home is named by the logo's description.
    await expect(page.getByRole('link', { name: 'Instituto Demo' })).toBeVisible();
    await expectAccessible(page);
    await shot(page, 'org-look-settings-light');
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
    await expect(page.getByRole('banner').getByTestId('app-sublogo')).toBeVisible();
    await shot(page, 'org-look-sublogo-light', { fullPage: false });

    // The same in the dark theme (the person's own choice wins over the organisation's).
    await page.evaluate(() => localStorage.setItem('ws.theme', 'dark'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByTestId('side-logo').getByRole('img')).toBeVisible();
    await expectAccessible(page);
    await shot(page, 'org-look-sublogo-dark', { fullPage: false });
    await page.goto('/admin/organisation');
    await expect(page.getByTestId('theme-preview')).toBeVisible();
    await shot(page, 'org-look-settings-dark');
    await page.evaluate(() => localStorage.removeItem('ws.theme'));
  } finally {
    await db.run(
      'UPDATE tenants SET branding = ?, logo_alt = NULL, logo_updated_at = NULL WHERE id = ?',
      [branding, tenantId],
    );
    await db.run('DELETE FROM tenant_logos WHERE tenant_id = ?', [tenantId]);
    await reset2fa();
    await db.end();
  }
});
