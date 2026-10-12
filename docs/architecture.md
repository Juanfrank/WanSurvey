# Architecture

```
packages/schema    Zod contracts shared by every client and the API (questionnaire, answers,
                   interview, paradata, dispositions, RBAC matrix)
packages/logic     Pure TypeScript. No DOM or Node APIs (enforced by lint). Parser, evaluator,
                   type checker, piping, static analyzer, compiler and routing engine
packages/renderer  (slice 3) React components that render a questionnaire per mode and device
apps/api           NestJS API: auth (global accounts, several organisations each), tenants,
                   users and roles, projects, audit. Later: cases,
                   interviews, sync
apps/web           (slice 3+) Staff app plus a lightweight respondent (CAWI) bundle; PWA for CAPI
apps/worker        (slice 9+) BullMQ jobs: e-mail, reminders, exports, stats aggregation
```

## One logic engine everywhere

`@wansurvey/logic` compiles a questionnaire into plain JSON (`CompiledQuestionnaire`). That JSON is:

- stored next to the published version, together with its SHA-256 `hash`;
- downloaded to offline tablets;
- loaded by the API.

`createInterview(compiled, { mode, context, now, seed, state })` returns an `InterviewSession`. It provides answering, routing, validation, navigation, piping and options, using the same code on the client and the server. On submit, the server calls `verifySubmission` and flags any path mismatch.

### Routing

Each change triggers a walk of the questionnaire in document order. The walk decides every node's status (`active`, `hidden`, `skipped`, `notInMode` or `ended`) and records why. Answers that fall off the path are moved to a stash during the walk itself, so later conditions never see stale answers. Values are restored if the path returns.

Expression results are cached per node and roster row. The compile-time **dependency graph** (variable → dependent nodes) invalidates only the nodes whose inputs changed. With 500 items, a change takes under 1 ms (median) in CI; the spec target is 20 ms on a mid-range tablet.

### Determinism

The following inputs are fixed per session, so a client and the server always agree:

- clock: `today()`;
- the randomisation seed;
- language and mode.

A fast-check property test drives random answer sequences and checks that the resulting state is a fixed point when replayed from a JSON round-trip of the compiled questionnaire.

## API request lifecycle

```
cookie ws_sid=<tenantId>.<token>
  → ThrottlerGuard (global; stricter limit on login and 2FA routes)
  → AuthGuard:  session lookup inside withTenant(tenantId)   [RLS]
                idle/absolute expiry, user still active
                MFA state (enroll / pending → 403 unless the route allows it)
                CSRF header on non-GET requests
                @RequirePermission(permission, { projectParam | anyProject })
  → controller → service → Database.withTenant(tenantId, tx => …)  [RLS]
                           AuditService.record(tx, …) in the same transaction
```

The database is split into two roles:

| Role                             | Owns tables | RLS                                                        | Used for                |
| -------------------------------- | ----------- | ---------------------------------------------------------- | ----------------------- |
| Owner (`DATABASE_ADMIN_URL`)     | yes         | not applied                                                | migrations and seeding  |
| `wansurvey_app` (`DATABASE_URL`) | no          | always applied (`NOBYPASSRLS`, `FORCE ROW LEVEL SECURITY`) | everything the API does |

## Extension points kept open

- `Invitation.channel` is an enum (`email | sms | whatsapp`) from day one, for Phase 2 WhatsApp and SMS.
- `Mailer` is a port. Provider adapters plug in without code changes elsewhere.
- Dispositions carry AAPOR codes, so response-rate metrics (slice 12) can be computed directly.
- `QuotaProvider` lets the server supply live quota-cell state.
- `TraceEntry.reason` feeds the designer's path tracer (slice 3).
