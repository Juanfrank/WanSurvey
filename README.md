# WanSurvey

WanSurvey is a multi-tenant platform for survey data collection. A questionnaire is designed once and fielded by phone (CATI), face to face on a tablet (CAPI), on the web (CAWI) or on paper (PAPI).

## Status

The MVP is built in 13 vertical slices; ten are done so far.

| Slice | Scope                                                                                                                                                                                                                                                                                                                                                                                                                 | State   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1     | **Foundations**: monorepo, CI, Docker, Postgres with RLS, auth (Argon2id, cookie sessions, TOTP 2FA, CSRF, rate limiting, Microsoft Entra ID sign-in), tenants, users and roles, projects, audit log                                                                                                                                                                                                                  | ✅      |
| 2     | **Schema and logic engine**: Zod questionnaire schema, expression parser and evaluator, routing, validation, piping, static analysis                                                                                                                                                                                                                                                                                  | ✅      |
| 3     | **Renderer and test mode**: every question type in all four modes (PAPI as a print-style paper form), keyboard operation, English/Spanish, web app with sign-in (password and Microsoft), organisation switcher, waiting-for-access page, and the designer preview with path tracer and saved test scenarios                                                                                                          | ✅      |
| 4     | **Questionnaire designer**: projects and questionnaires, keyboard-driven outline, editors for every item type, mode variants, scripts, quotas, visual condition builder, autosaved drafts with conflict detection, publish checks (errors, saved scenarios, breaking-change mapping) and immutable versions                                                                                                           | ✅      |
| 5     | **Cases and assignments**: CSV/XLSX sample import with column mapping and a validation report, the case list with filters, bulk assignment, assignment rules with quotas, case history, and personal data masked with audited reveal                                                                                                                                                                                  | ✅      |
| +     | **Review round additions**: drag-and-drop outline, translation export/import (CSV, XLIFF 2.0), version comparison, comments on items, question library, light co-editing (presence and three-way merge), per-project settings (automatic personal data for interviewers, open pool of cases), geocoding with OpenStreetMap and a case map, duplicate detection across projects, translated engine and server messages | ✅      |
| 6     | **Interview runtime and autosave**: interviewer screen (case details, section navigator, notes, pause, keyboard shortcuts), answers kept on the device in IndexedDB and synced in numbered batches, "Saved" only when the server has them, timing and navigation paradata, server-checked submission, and the full answer history per case                                                                            | ✅      |
| 7     | **CATI**: call queue with callbacks first, locks so no case is served twice, calling hours in the respondent's time zone, outcomes mapped to AAPOR dispositions with retries, callbacks and appointments, scripts, and a keyboard-first Phone calls workspace with timers and the case's call history                                                                                                                 | ✅      |
| 8     | **CAPI offline**: installable app with a service worker, cases downloaded to one device, interviews started, continued and submitted with no connection and sent automatically when back online, optional location at start and end, and supervisor release of a lost device                                                                                                                                          | ✅      |
| 9     | **CAWI and e-mail**: invitation and reminder wording with preview, waves with reminders and a send funnel, tracking of opens and clicks, bounce webhook and do-not-e-mail list, unsubscribe, lawful-basis check, and the respondent survey (phone-friendly, resumable on any device) plus open links                                                                                                                  | ✅      |
| 10    | **PAPI**: printable forms per case with a QR code and the paper form, keying by clerks (typed or scanned case id, numeric codes, the date and duration written on the form), and double entry with a supervisor's list of differences to resolve                                                                                                                                                                      | ✅      |
| 11–13 | Review, metrics and exports, hardening                                                                                                                                                                                                                                                                                                                                                                                | planned |

Background reading:

- [`docs/architecture.md`](docs/architecture.md): how the pieces fit together
- [`docs/logic-language.md`](docs/logic-language.md): the expression language
- [`docs/decisions.md`](docs/decisions.md): assumptions taken where the spec was ambiguous
- [`docs/sso-entra.md`](docs/sso-entra.md): connecting an organisation's Microsoft Entra ID (Azure AD) for sign-in

Questionnaires are written and conducted in Spanish; other languages can be added and are edited one at a time. The interface is in Spanish by default, with English available.

## Requirements

- Node 22
- pnpm 10
- Postgres 16
- Redis 7 (unused until the background worker; e-mail runs in-process for now, W5)

## Getting started

1. Install dependencies and start the databases (or use local Postgres):

   ```bash
   pnpm install
   docker compose up -d postgres redis   # creates the `wansurvey` and `wansurvey_test` databases
   ```

2. Configure the API:

   ```bash
   cp apps/api/.env.example apps/api/.env
   # set APP_ENCRYPTION_KEY to the output of: openssl rand -base64 32
   ```

3. Build, migrate and seed. Migrations create and update the restricted `wansurvey_app` role.

   ```bash
   pnpm build
   cd apps/api
   set -a; . ./.env; set +a
   pnpm db:migrate
   pnpm db:seed      # organisations "demo" and "demo2", one user per role, password = SEED_PASSWORD
   pnpm dev          # http://localhost:3000/health, OpenAPI at /docs
   ```

4. In another terminal, start the web app (it proxies `/api` to port 3000):

   ```bash
   pnpm --filter @wansurvey/web dev   # http://localhost:5173
   ```

   Sign in, then open **Projects → Household Survey 2026**. Its tabs hold the questionnaires, the 50 seeded cases, **Import sample** (CSV or Excel with one row per case) and **Assignments**. Open a questionnaire to edit the seeded questionnaire in the designer, or **Questionnaire preview** to run the samples (or your own JSON) in any mode.

Seeded accounts log in with their e-mail only, for example `project.manager@demo.wansurvey.test`. That account belongs to two organisations, `demo` and `demo2`, and can switch between them. The owner and admin accounts must enrol TOTP on their first login.

## Checks

```bash
pnpm lint && pnpm format:check
pnpm typecheck
pnpm test
```

`pnpm test` runs the unit suites:

| Package             | What it covers                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema`   | Schema validation                                                                                                                                                                |
| `packages/logic`    | Unit tests, fast-check properties, and a performance test on a 500-item questionnaire                                                                                            |
| `packages/renderer` | Every control and layout in each mode, keyboard behaviour, Spanish, the paper form; axe-core accessibility checks                                                                |
| `apps/web`          | API client, sign-in redirects and the waiting page                                                                                                                               |
| `apps/api`          | Runs against the `wansurvey_test` database, which the suite recreates on each run. Covers RLS isolation, auth and 2FA, the full role × endpoint denial matrix, and the audit log |

The API tests connect as `postgres://wansurvey_app:wansurvey_app@localhost:5432/wansurvey_test`. To use another database, set `TEST_DATABASE_URL` and `TEST_DATABASE_ADMIN_URL`.

End-to-end tests (Playwright, Chromium) run the built API and web app against a fresh `wansurvey_e2e` database:

```bash
pnpm build && pnpm e2e
```

They cover:

- a CATI interview completed with the keyboard only;
- path changes and the tracer;
- CAWI at phone width and the PAPI form;
- saved scenarios;
- sign-in, organisation switching and the waiting page;
- Microsoft sign-in redirects;
- browser accessibility checks, including colour contrast.
