import type { Diagnosis } from './diagnose.js';

/**
 * What the wizard is doing in this process: with no DATABASE_URL (`missing`) it only gives scripts
 * and settings; with one that does not work yet (`not-ready`) it also says which step is pending and
 * starts the application by itself as soon as the database is ready.
 */
export const setupState: {
  mode: 'missing' | 'not-ready';
  diagnosis: Diagnosis | null;
  /** Looks again now (and starts the application if everything is ready). */
  check: () => Promise<Diagnosis | null>;
} = {
  mode: 'missing',
  diagnosis: null,
  check: async () => null,
};
