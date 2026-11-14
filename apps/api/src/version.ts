import { readFileSync } from 'node:fs';

/**
 * The product version (Semantic Versioning; see docs/releasing.md), read from the `package.json`
 * next to `src/` and `dist/`, which the App Service zip carries too. "unknown" if it cannot be read.
 */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/**
 * Who wrote the application: a fixed fact of the project, not a setting of the installation (there
 * is no environment variable for it). It is shown on the About page.
 */
export const AUTHOR = 'Juan Francisco Medina';
