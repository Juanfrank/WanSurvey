import { pathToFileURL } from 'node:url';
import { copyData, openSource, openTarget, plan } from './copy.js';
import { verifyCopy } from './verify.js';

/**
 * `node dist/db/copy/cli.js plan|copy|verify|all`
 *
 *   SOURCE_DATABASE_URL        postgres://…  an owner of the PostgreSQL database
 *   TARGET_DATABASE_ADMIN_URL  mssql://…     an owner of the SQL Server database, migrated and empty
 *   COPY_SKIP=sessions,…       tables left out (comma separated)
 *   COPY_ONLY=cases,…          only these tables
 *   COPY_APPEND=1              copy into tables that already hold rows
 */
export async function main(argv: string[]): Promise<number> {
  const [command = 'all'] = argv;
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_ADMIN_URL;
  if (!sourceUrl || !targetUrl) {
    console.error('SOURCE_DATABASE_URL and TARGET_DATABASE_ADMIN_URL are required');
    return 2;
  }
  const list = (v?: string) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const common = {
    sourceUrl,
    targetUrl,
    skip: list(process.env.COPY_SKIP),
    only: list(process.env.COPY_ONLY),
    log: (m: string) => console.log(m),
  };
  if (command === 'plan') {
    const src = openSource(sourceUrl);
    const dst = openTarget(targetUrl);
    try {
      const p = await plan(src, dst, common);
      for (const t of p.tables)
        console.log(
          `${t.table}: ${t.columns.length} columns` +
            (t.onlySource.length ? `; only in PostgreSQL: ${t.onlySource.join(', ')}` : '') +
            (t.onlyTarget.length ? `; only in SQL Server: ${t.onlyTarget.join(', ')}` : ''),
        );
      if (p.sourceOnly.length)
        console.log(`Tables only in PostgreSQL (not copied): ${p.sourceOnly.join(', ')}`);
      if (p.targetOnly.length) console.log(`Tables only in SQL Server: ${p.targetOnly.join(', ')}`);
    } finally {
      await src.end({ timeout: 5 });
      await dst.destroy();
    }
    return 0;
  }
  if (command === 'copy' || command === 'all') {
    const r = await copyData({ ...common, append: process.env.COPY_APPEND === '1' });
    console.log(`Copied ${r.total} rows in ${r.tables.length} tables, ${r.seconds.toFixed(1)} s.`);
  }
  if (command === 'verify' || command === 'all') {
    const v = await verifyCopy(common);
    const bad = v.tables.filter((t) => t.mismatches.length);
    for (const t of bad) {
      console.error(`PROBLEM in ${t.table}:`);
      for (const m of t.mismatches) console.error(`  ${m}`);
    }
    console.log(
      v.ok ? `Verified: ${v.tables.length} tables match.` : `${bad.length} table(s) differ.`,
    );
    return v.ok ? 0 : 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
