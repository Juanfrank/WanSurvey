import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'demo-password-123';
export const PM = 'project.manager@demo.wansurvey.test';

export async function login(page: Page, email = PM) {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

const require = createRequire(import.meta.url);

/** axe-core in the real browser, including colour contrast. */
export async function expectAccessible(page: Page, include?: string) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async (sel) => {
    const axe = (
      window as unknown as {
        axe: {
          run(
            ctx: unknown,
            opts: unknown,
          ): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      }
    ).axe;
    const r = await axe.run(sel ? { include: [sel] } : document, { resultTypes: ['violations'] });
    return r.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    );
  }, include ?? null);
  expect(violations).toEqual([]);
}

export async function shot(page: Page, name: string) {
  if (process.env.SCREENSHOTS)
    await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png`, fullPage: true });
}
