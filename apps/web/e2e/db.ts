import { openRaw } from '../../api/dist/db/mssql/raw.js';

export const adminUrl =
  process.env.E2E_MSSQL_ADMIN_URL ??
  'mssql://sa:Wansurvey_Test1%21@localhost:1433/wansurvey_e2e?trustServerCertificate=true';

export type Row = Record<string, unknown>;

export interface E2eDb {
  /** Rows of a T-SQL query with `?` placeholders. */
  all(text: string, params?: unknown[]): Promise<Row[]>;
  run(text: string, params?: unknown[]): Promise<void>;
  end(): Promise<void>;
}

/** The owner's connection to the browser tests' database. */
export function connectDb(): E2eDb {
  const raw = openRaw(adminUrl);
  return {
    all: async (text, params = []) => (await raw.query(text, params)).map(lowerGuids),
    run: async (text, params = []) => void (await raw.query(text, params)),
    end: () => raw.end(),
  };
}

/** SQL Server writes GUIDs in capitals; the API and the tests use them in lower case. */
const GUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const lowerGuids = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === 'string' && GUID.test(v) ? v.toLowerCase() : v,
    ]),
  );

/** `?, ?, ?` for an IN list. */
export const marks = (n: number) => Array(n).fill('?').join(', ');
