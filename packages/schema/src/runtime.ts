import { z } from 'zod';

/**
 * In browsers, schemas validate without generated code (H4): the web app's
 * Content-Security-Policy forbids `new Function`, and Zod's probe for it is reported as a
 * violation. Servers keep Zod's faster compiled validation.
 */
const g = globalThis as { window?: unknown; document?: unknown };
if (g.window !== undefined && g.document !== undefined) z.config({ jitless: true });
