# WanSurvey

WanSurvey is a multi-tenant platform for survey data collection. A questionnaire is designed once and fielded by phone (CATI), face to face on a tablet (CAPI), on the web (CAWI) or on paper (PAPI).

## Status

The MVP is built in 13 vertical slices; two are done so far.

| Slice | Scope                                                                                                                                                                    | State   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 1     | **Foundations**: monorepo, CI, Docker, Postgres with RLS, auth (Argon2id, cookie sessions, TOTP 2FA, CSRF, rate limiting), tenants, users and roles, projects, audit log | ✅      |
| 2     | **Schema and logic engine**: Zod questionnaire schema, expression parser and evaluator, routing, validation, piping, static analysis                                     | ✅      |
| 3–13  | Renderer, designer, cases, runtime and sync, CATI, CAPI, CAWI, PAPI, review, metrics, hardening                                                                          | planned |

Background reading:

- [`docs/architecture.md`](docs/architecture.md): how the pieces fit together
- [`docs/logic-language.md`](docs/logic-language.md): the expression language
- [`docs/decisions.md`](docs/decisions.md): assumptions taken where the spec was ambiguous

## Requirements

- Node 22
- pnpm 10
- Postgres 16
- Redis 7 (unused until slice 9)

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

Seeded accounts log in with their e-mail only, for example `project.manager@demo.wansurvey.test`. That account belongs to two organisations, `demo` and `demo2`, and can switch between them. The owner and admin accounts must enrol TOTP on their first login.

## Checks

```bash
pnpm lint && pnpm format:check
pnpm typecheck
pnpm test
```

`pnpm test` runs three suites:

| Package           | What it covers                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema` | Schema validation                                                                                                                                                                |
| `packages/logic`  | Unit tests, fast-check properties, and a performance test on a 500-item questionnaire                                                                                            |
| `apps/api`        | Runs against the `wansurvey_test` database, which the suite recreates on each run. Covers RLS isolation, auth and 2FA, the full role × endpoint denial matrix, and the audit log |

The API tests connect as `postgres://wansurvey_app:wansurvey_app@localhost:5432/wansurvey_test`. To use another database, set `TEST_DATABASE_URL` and `TEST_DATABASE_ADMIN_URL`.
