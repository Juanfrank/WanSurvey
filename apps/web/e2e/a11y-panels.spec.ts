import { expect, overlaysSettled, test, type Page } from './fixtures.js';
import { expectAccessible, login, openAccount } from './helpers.js';

/**
 * Side panels and menus, in each state they can be in, with axe (colour contrast included) and
 * the keyboard: the application's side panel (open, compact, over the content, on a phone), the
 * account menu, and the side drawers of the designer (outline) and the calls screen (callbacks).
 */
const INTERVIEWER = 'interviewer@demo.wansurvey.test';

async function openProject(page: Page, email?: string) {
  await login(page, email);
  await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('main').getByRole('link', { name: 'Household Survey 2026' }).click();
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible();
}

test('the application side panel: open, compact, opened over the content, by keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();
  await expectAccessible(page);

  // Compact: a rail of icons; every link keeps its name for a screen reader.
  await page.getByRole('button', { name: 'Compact the side panel' }).click();
  const toggle = page.getByRole('button', { name: 'Keep the side panel open' });
  await expect(toggle).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toBeAttached();
  await page.mouse.move(900, 500);
  await expectAccessible(page);

  // Keyboard focus on the rail opens it over the content; leaving closes it.
  await nav.getByRole('link', { name: 'Home' }).focus();
  await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('main').focus();

  // Pointing at it opens it too.
  await page.getByRole('banner').hover();
  await expectAccessible(page);
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Compact the side panel' })).toBeVisible();
});

test('the application side panel on a phone is a bar of tabs, and is accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await login(page);
  await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expectAccessible(page);
  // No sideways scrolling at this width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the account menu: opens, is accessible, closes with Escape and returns the focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
  const badge = page.getByRole('button', { name: /^Account:/ });
  await expect(badge).toHaveAttribute('aria-expanded', 'false');
  await openAccount(page);
  await expect(badge).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('combobox', { name: 'Organisation' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('combobox', { name: 'Language' }).focus();
  await page.keyboard.press('Escape');
  await expect(badge).toHaveAttribute('aria-expanded', 'false');
  await expect(badge).toBeFocused();
});

test('the outline drawer of the designer: pinned, as a rail, over the editor; names and keys', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openProject(page);
  await page.getByRole('tab', { name: 'Questionnaires', exact: true }).click();
  await page.getByRole('link', { name: 'Household questionnaire' }).click();
  await expect(page.getByRole('tree', { name: 'Outline' })).toBeVisible();
  const outline = page.getByRole('complementary', { name: 'Outline' });
  await expect(outline).toBeVisible();
  await expectAccessible(page);
  // Unpinned: a rail whose button says whether the pane is open and what it controls.
  await page.getByRole('button', { name: 'Unpin: Outline' }).click();
  const rail = page.getByRole('button', { name: 'Outline', exact: true });
  await expect(rail).toHaveAttribute('aria-expanded', 'false');
  await expectAccessible(page);
  await page.keyboard.press('Alt+o');
  await expect(page.getByRole('tree', { name: 'Outline' })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tree', { name: 'Outline' })).toBeHidden();
  await expect(rail).toBeFocused();
});

test('the callbacks drawer of the calls screen: pinned, as a rail, over the content', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openProject(page, INTERVIEWER);
  await page.getByRole('tab', { name: 'Calls' }).click();
  const drawer = page.getByRole('complementary', { name: 'My callbacks' });
  await expect(drawer).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Unpin: My callbacks' }).click();
  const rail = page.getByRole('button', { name: /^My callbacks/ });
  await expect(rail).toHaveAttribute('aria-expanded', 'false');
  await expectAccessible(page);
  await rail.click();
  await expect(rail).toHaveAttribute('aria-expanded', 'true');
  await overlaysSettled(page, 0);
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(rail).toHaveAttribute('aria-expanded', 'false');
  await expect(rail).toBeFocused();
});
