import postgres from 'postgres';
import { openRaw } from '../../api/dist/db/mssql/raw.js';

/** The engine the browser tests run on: `E2E_ENGINE=mssql` for SQL Server, PostgreSQL otherwise. */
export const MSSQL = process.env.E2E_ENGINE === 'mssql';

export const adminUrl = MSSQL
  ? (process.env.E2E_MSSQL_ADMIN_URL ??
    'mssql://sa:Wansurvey_Test1%21@localhost:1433/wansurvey_e2e?trustServerCertificate=true')
  : (process.env.E2E_DATABASE_ADMIN_URL ??
    'postgres://postgres:postgres@localhost:5432/wansurvey_e2e');

export type Row = Record<string, unknown>;

export interface E2eDb {
  /** Rows of a query with `?` placeholders; `mssql` is the T-SQL variant when it differs. */
  all(text: string, params?: unknown[], mssql?: string): Promise<Row[]>;
  run(text: string, params?: unknown[], mssql?: string): Promise<void>;
  end(): Promise<void>;
}

/** The owner's connection to the browser tests' database, on either engine. */
export function connectDb(): E2eDb {
  if (MSSQL) {
    const raw = openRaw(adminUrl);
    return {
      all: (text, params = [], mssql) => raw.query(mssql ?? text, params),
      run: async (text, params = [], mssql) => void (await raw.query(mssql ?? text, params)),
      end: () => raw.end(),
    };
  }
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const numbered = (text: string) => {
    let n = 0;
    return text.replace(/\?/g, () => `$${++n}`);
  };
  return {
    all: async (text, params = []) =>
      [...(await sql.unsafe(numbered(text), params as never[]))] as Row[],
    run: async (text, params = []) => void (await sql.unsafe(numbered(text), params as never[])),
    end: () => sql.end(),
  };
}

/** `?, ?, ?` for an IN list. */
export const marks = (n: number) => Array(n).fill('?').join(', ');
