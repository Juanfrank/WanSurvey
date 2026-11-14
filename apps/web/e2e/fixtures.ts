import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

export * from '@playwright/test';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/**
 * Runs in every page: each time a modal dialog, dialog or ARIA modal appears, axe-core checks the
 * whole page while it is open (colour contrast included), once per element. It keeps its own copy
 * of axe, apart from the one the tests inject, so the two never run at the same time on one
 * instance. The fixture below reads the result when the test ends.
 */
const watcher = `
(() => {
  const axe = window.axe;
  delete window.axe;
  const ov = (window.__ov = { checked: 0, skipped: 0, violations: [], pending: 0, kinds: [] });
  const seen = new WeakSet();
  const SEL = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const name = (el) => {
    const id = el.getAttribute('aria-labelledby');
    const t = id && document.getElementById(id.split(' ')[0]);
    return ((t && t.textContent) || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 40);
  };
  let chain = Promise.resolve();
  const scan = () => {
    for (const el of document.querySelectorAll(SEL)) {
      if (seen.has(el)) continue;
      seen.add(el);
      ov.pending++;
      setTimeout(() => {
        chain = chain.then(async () => {
          try {
            const r = el.getBoundingClientRect();
            if (!el.isConnected || r.width === 0 || r.height === 0) {
              ov.skipped++;
              return void (window.__ovReport && window.__ovReport({ skipped: true }));
            }
            const label = name(el);
            const res = await axe.run(document, { resultTypes: ['violations'] });
            ov.checked++;
            ov.kinds.push(label);
            const found = res.violations.map(
              (v) => label + ' - ' + v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '),
            );
            ov.violations.push(...found);
            if (window.__ovReport) window.__ovReport({ label, violations: found });
          } catch (e) {
            ov.violations.push('axe failed: ' + e.message);
          } finally {
            ov.pending--;
          }
        });
      }, 30);
    }
  };
  new MutationObserver(scan).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'role', 'aria-modal'],
  });
})();
`;

/**
 * Waits until axe has looked at the dialog that has just opened (the checks start a moment after
 * it appears, and a quick test could close it first). Call it right after the click that opens it.
 */
export async function overlaysSettled(page: Page, minimum = 1): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const ov = (
        window as unknown as { __ov?: { checked: number; skipped: number; pending: number } }
      ).__ov;
      return !!ov && ov.pending === 0 && ov.checked + ov.skipped >= n;
    },
    // The count is of this page since it loaded: callers pass how many dialogs it has had.
    minimum,
    { timeout: 15_000 },
  );
}

type Seen = { checked: number; skipped: number; violations: string[]; kinds: string[] };

/** The `watch` of the test that is running: the browser is patched once, for the whole worker. */
let current: ((c: BrowserContext) => Promise<void>) | null = null;
const patched = new WeakSet<Browser>();

export const test = base.extend<{ overlays: void }>({
  overlays: [
    async ({ browser, context }, use, testInfo) => {
      const init = `${axeSource};\n${watcher}`;
      // What every page of the test reports (also those of browsers the test has closed).
      const all: Seen = { checked: 0, skipped: 0, violations: [], kinds: [] };
      const contexts = new Set<BrowserContext>();
      const watch = async (c: BrowserContext) => {
        contexts.add(c);
        await c.exposeFunction(
          '__ovReport',
          (r: { skipped?: boolean; label?: string; violations?: string[] }) => {
            if (r.skipped) all.skipped++;
            else {
              all.checked++;
              all.kinds.push(r.label ?? '');
              all.violations.push(...(r.violations ?? []));
            }
          },
        );
        await c.addInitScript(init);
      };
      await watch(context);
      current = watch;
      if (!patched.has(browser)) {
        patched.add(browser);
        const newContext = browser.newContext.bind(browser);
        (browser as { newContext: typeof newContext }).newContext = async (options) => {
          const c = await newContext(options);
          await current?.(c);
          return c;
        };
        (browser as { newPage: Browser['newPage'] }).newPage = async (options) =>
          (await browser.newContext(options)).newPage();
      }
      await use();
      current = null;
      // Checks still running in the pages that are open.
      for (const c of contexts)
        for (const page of c.pages())
          if (!page.isClosed())
            await page
              .evaluate(async () => {
                const ov = (window as unknown as { __ov?: { pending: number } }).__ov;
                for (let i = 0; ov && i < 40 && ov.pending > 0; i++)
                  await new Promise((r) => setTimeout(r, 100));
              })
              .catch(() => undefined);
      if (process.env.OVERLAY_LOG)
        appendFileSync(
          process.env.OVERLAY_LOG,
          JSON.stringify({ test: testInfo.title, ...all }) + '\n',
        );
      expect(all.violations, 'accessibility of the dialogs opened in this test').toEqual([]);
    },
    { auto: true },
  ],
});
