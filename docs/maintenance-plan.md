# Maintenance plan (prepared, not yet run)

Three clean-ups left after the move to SQL Server. Each is a separate commit, checked by the same
gate before pushing: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build`, `pnpm test`,
and `pnpm --filter @wansurvey/api test:mssql` against a SQL Server (`docker compose up -d mssql
mssql-init`, then `MSSQL_ADMIN_URL` and `MSSQL_URL` as in the README). Browser tests (`pnpm e2e`) run
in CI; run them locally too for step 2.

## 1. Comments that still describe PostgreSQL

Sources: about 40 header comments in `apps/api/src/**/*-store.mssql.ts`, `*-repo.ts`, `db/` and
`interviews/` say "what `x.service.ts` does on PostgreSQL with Drizzle", "the PostgreSQL side is the
Drizzle code…", "until PostgreSQL is retired both exist", "as on PostgreSQL", "the modules that
have not moved", "(docs/roadmap.md)".

1. List them: `grep -rniE "postgres|drizzle|pg_|not (yet )?moved|until the switch|docs/roadmap" apps/api/src apps/api/test apps/web/e2e`.
2. Edit by hand, file by file; no blind `sed` (some mentions are true and useful, e.g. why
   `idOrder` exists or what `ON CONFLICT DO NOTHING` became). Rule: say what the code does on SQL
   Server today; keep a comparison with PostgreSQL only where it explains a non-obvious choice.
3. Stale names: `TxHandle` text mentioning "either engine", the "Rows come out in one shape, as
   Drizzle returned them" lines, `fixtures.ts` ("Rows as the PostgreSQL client gave them").
4. Comments only: `git diff` must show no code lines (`git diff -U0 | grep '^[+-]' | grep -vE '^(\+\+\+|---)|^[+-]\s*(//|\*|/\*)'` is empty), so the gate is lint and prettier.

## 2. The 16 `react-hooks/exhaustive-deps` warnings

`pnpm lint 2>&1 | grep -B1 warning` lists them. For each one decide, with the component open:

| Case                                                                                                         | Action                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Value is a stable function or constant (`t`, `navigate`, `flush`)                                            | Add it to the dependencies; if it changes every render, wrap it in `useCallback` at its source. |
| Effect must run only when one value changes (load, redirect, sync)                                           | Keep the dependencies; read the rest through a ref (`useRef` updated each render).              |
| `data = x ?? []` makes a new array each render (`CaseMap`, `CasesTab`, `InterviewRunner` `pages`/`pageKeys`) | Wrap the initialisation in `useMemo`.                                                           |

Files: `cases/CaseMap.tsx`, `cases/CasesTab.tsx` (2), `cawi/CawiTab.tsx`, `designer/ConditionBuilder.tsx`,
`designer/DesignerPage.tsx`, `designer/ProjectPages.tsx` (2), `designer/PublishDialog.tsx` (2),
`designer/fields.tsx`, `feedback/FeedbackPage.tsx`, `preview/PreviewPage.tsx`,
`packages/renderer/src/InterviewRunner.tsx` (3). Do one file per commit-sized step, run that
feature's Playwright spec after each (`pnpm --filter @wansurvey/web exec playwright test <spec>`),
and never silence a warning with `eslint-disable` without a comment saying why the effect is
intentional. End state: `pnpm lint` prints no warnings; then make warnings fail the build
(`--max-warnings 0` in the root `lint` script).

## 3. Dead code

1. Compiler: add `noUnusedLocals` and `noUnusedParameters` to `tsconfig.base.json`, run `pnpm typecheck`, remove what it reports (revert the flags if parameters of interface implementations make it noisy; keep `noUnusedLocals`).
2. Unused files, exports and dependencies: `npx knip@6.41.0` (published 9 October 2026; newer ones are under two weeks old on 31 October, check the date again when you run it) at the root, with a `knip.json` that lists the entry points: `apps/api/src/main.ts`, `worker.ts`, `db/seed.ts`,
   `db/seed-demo.ts`, `db/mssql/migrate.ts`, `apps/web/src/main.tsx`, the Playwright and Vitest
   specs, and `packages/*/src/index.ts`. Do not add it to `package.json` until it is clean.
3. Review the report by category, never apply it blindly: Nest providers and decorators are used
   through metadata, so "unused" classes in modules need a check in `app.module.ts`; exported types
   used only by tests count as used.
4. Likely candidates already seen: `COUNTED_SQL`-style helpers in `common/statuses.ts`, leftovers
   in `db/common.ts`, `Engine` methods nobody calls (`probe`, `shareLinkByHash`…), the
   `docs/data-copy.md` links, and the `mssql/` migrations (never delete: they are history).
5. Remove in small commits by area (API, web, packages), gate after each. When done, add a `knip`
   script and a CI step so it stays clean.

## Results of the first run (31 October 2026)

Run with `knip@6.41.0` and the entry points above; nothing was deleted.

- **Compiler (`noUnusedLocals`, `noUnusedParameters`)**: done and now permanent in
  `tsconfig.base.json`. It removed eight unused constructor properties and four unused parameters.
- **Unused files (3), all false positives**: `apps/api/src/db/mssql/raw.ts` is imported by the browser
  tests from the built `dist`; `packages/schema/src/feedback.ts` and `sampling.ts` are package
  entry points (`exports` in its `package.json`). Add them as entries in `knip.json` before using it
  in CI.
- **Unused devDependencies (6), to check one by one before removing**: `azurite` (started by
  `test/support/azurite.ts`), `tailwindcss` (used by the build's PostCSS configuration),
  `@wansurvey/api` in `apps/web` (the browser tests import its `dist`), `@types/multer`,
  `@wansurvey/fixtures` in `packages/exporters`, `axe-core` in `packages/renderer`. Checked: `@types/multer` (no use of
  its types), `@wansurvey/fixtures` in `exporters` (nothing imports it) were removed; `axe-core` stays
  (`packages/renderer/test/axe.ts` imports it).
- **Unused exports (108)**: mostly the `export` keyword on things used only inside their file
  (the `Mssql*Tx` classes, helpers like `distribute`, `shuffle`, `hotp`), or exported for tests. Not
  dead code; removing the keyword is optional tidiness, not a priority. The few that look like real
  leftovers: `sqlNumber` in `db/common.ts`, `COUNTED` re-exported from `stats/stats.service.ts`,
  `EXPORT_MAX_ATTEMPTS`, `SCAN_STUCK_MS`.
- **Unlisted binaries**: `pdftotext` and `pdftoppm` (system tools of the browser tests, installed in CI).
