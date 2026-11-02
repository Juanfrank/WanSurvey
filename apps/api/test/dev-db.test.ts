import { describe, expect, it } from 'vitest';
import { devDatabase, devUrls } from '../src/db/dev-db.js';

describe('development database', () => {
  it('builds the URLs of the same server: owner, and the restricted user', () => {
    const u = devUrls(
      'mssql://sa:P%40ss@localhost:1433/master?trustServerCertificate=true',
      'wansurvey_dev',
      'App-pw1!',
    );
    expect(u.master).toBe('mssql://sa:P%40ss@localhost:1433/master?trustServerCertificate=true');
    expect(u.admin).toBe(
      'mssql://sa:P%40ss@localhost:1433/wansurvey_dev?trustServerCertificate=true',
    );
    expect(u.app).toBe(
      'mssql://wansurvey_app:App-pw1!@localhost:1433/wansurvey_dev?trustServerCertificate=true',
    );
    // What the application reads back from the URL.
    expect(decodeURIComponent(new URL(u.app).password)).toBe('App-pw1!');
  });

  it('asks for the admin login, and refuses names it should not drop', async () => {
    const log = () => undefined;
    await expect(devDatabase({}, [], log)).rejects.toThrow(/DEV_DB_ADMIN_URL is required/);
    for (const bad of ['master', 'TempDB', 'x]; DROP DATABASE y;--'])
      await expect(
        devDatabase(
          { DEV_DB_ADMIN_URL: 'mssql://sa:x@localhost/master', DEV_DB_NAME: bad },
          [],
          log,
        ),
      ).rejects.toThrow(/DEV_DB_NAME/);
  });
});
