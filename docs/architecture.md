# Architecture

```
packages/schema    Zod contracts shared by every client and the API (questionnaire, answers,
                   interview, paradata, dispositions, RBAC matrix)
packages/logic     Pure TypeScript. No DOM or Node APIs (enforced by lint). Parser, evaluator,
                   type checker, piping, static analyzer, compiler and routing engine
packages/fixtures  Sample questionnaires shared by tests, the preview and seeds
packages/renderer  React: a control per question type, InterviewRunner (modes, keyboard,
                   announcements), PaperForm (PAPI print layout); English and Spanish
apps/api           NestJS API: auth (global accounts, several organisations each), tenants,
                   users and roles, projects, audit. Later: cases,
                   interviews, sync
apps/web           Vite SPA: sign-in (password, TOTP, Microsoft), organisation switcher,
                   waiting page, designer preview with path tracer and test scenarios.
                   Later: respondent (CAWI) bundle, CAPI PWA
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

## Renderer and test mode

The renderer draws from a live `InterviewSession`. Wording, options and validation come from the session, so what the preview shows is exactly what the engine decides.

- **Interviewer modes (CATI, CAPI):** one question per screen.
- **CAWI:** pages split at page breaks and sections on wide screens, one question per page on phones.
- **PAPI:** `PaperForm` lays the compiled questionnaire out as a paper form, and `describeCondition` turns routing into instructions such as "If Q4 is not “Married” (1) → go to Q6".

The preview (`apps/web/src/preview`) validates, analyses and compiles questionnaires in the browser, so no server round trip is needed.

Changing the mode, date, case data or quotas rebuilds the session from its current state, so a single run can be checked in every mode.

Each run is recorded as a **scenario**: the answers in order plus the resulting path, outcome and answers. `runScenario` (in `@wansurvey/logic`) replays it; in the designer, scenarios are stored on the server and every one runs on publish.

## Designer, drafts and versions

```
questionnaires (one per questionnaire)       questionnaire_versions (immutable)
  draft (jsonb, may be invalid)                version 1, 2, … · definition · compiled · hash
  draft_revision  ──optimistic lock──▶         mapping from the previous version (breaking changes)
questionnaire_scenarios (saved test runs) ──run on every publish──┘
```

- **Draft.** The designer (`apps/web/src/designer`) edits the questionnaire JSON in memory: pure tree edits (`tree.ts`), undo/redo, and an autosave 1.5 s after the last change. Each save sends the revision it started from; if someone else saved in between, the API answers `409 DRAFT_CONFLICT` and the designer asks whether to keep theirs or overwrite. Diagnostics run in the browser on every change (the same `analyze` as the server).
- **Condition builder.** Conditions are stored as expression text. `toRows` turns an expression into builder rows (variable, comparison, value; joined by all/any) when it fits, `fromRows` prints rows back through the precedence-aware `printExpr`. Anything else stays in the expression editor.
- **Publish.** `POST …/publish-check` (dry run) and `POST …/publish` run the same checks: Zod format, analyzer errors, every saved scenario, and — against the last published version — `breakingChanges` (removed variables, type changes, removed codes, roster moves, removed grid rows), which must each have a `rename`, `recode` or `drop` mapping. Publishing locks the questionnaire row, compiles, and stores the definition, compiled form, hash and mapping. A trigger keeps versions immutable; only `published → retired` is allowed.
- Interviews (slice 6) will bind to a version; exports (slice 12) apply the stored mappings to line up data across versions.
