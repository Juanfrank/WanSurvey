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

- **Draft.** The designer (`apps/web/src/designer`) edits the questionnaire JSON in memory: pure tree edits (`tree.ts`), undo/redo, and an autosave 1.5 s after the last change. Each save sends the revision it started from; if someone else saved in between, the API answers `409 DRAFT_CONFLICT` and the designer merges (below). Diagnostics run in the browser on every change (the same `analyze` as the server).
- **Condition builder.** Conditions are stored as expression text. `toTree` turns an expression into a tree of all/any groups and conditions (variable, `case.*` or function compared with a value, variable or function) when it fits; `fromTree` prints it back through the precedence-aware `printExpr`. `describeCondition` gives the plain-language summary, and "Try it" evaluates the condition against sample answers with the engine's own evaluator.
- **Routing map.** `routingMap()` derives, per item, its show-if, skips (resolved targets), end rules, checks, roster loop and which items read its variable. The Routing tab draws it as a spine with skip arrows; the outline shows the same as badges and arcs.
- **Publish.** `POST …/publish-check` (dry run) and `POST …/publish` run the same checks: Zod format, analyzer errors, every saved scenario, and — against the last published version — `breakingChanges` (removed variables, type changes, removed codes, roster moves, removed grid rows), which must each have a `rename`, `recode` or `drop` mapping. Publishing locks the questionnaire row, compiles, and stores the definition, compiled form, hash and mapping. A trigger keeps versions immutable; only `published → retired` is allowed.
- **Working together.** Every open designer sends a heartbeat (`PUT …/presence`, every 5 s) with the item it is on, and gets back the other editors and the draft's head revision. When the head is newer, `useDraft.sync()` fetches it: with no local edits it is loaded; otherwise `mergeDrafts(base, mine, theirs)` (`merge.ts`) merges three ways against the draft both started from. Items merge by id — content, parent and order separately — and questionnaire-level parts (title, languages, settings, answer sets, scripts, quotas) as whole values, so edits to different items combine and are autosaved. Only the same thing changed differently on both sides opens the conflict dialog, listing what clashed. An item both sides added under the same new id is renamed on the local side first. Being on the same item as someone else shows a notice but never locks.
- **Comments** (`questionnaire_comments`) are threads on an item or the whole questionnaire; replies sit one level deep, and only threads are resolved (a new reply reopens one). Anyone with `questionnaires.comment` or `.edit` writes; clients and reviewers have `comment`.
- **Translations** (`translations.ts` in logic) key every text by item id and field, option code, check id or mode, export CSV or XLIFF 2.0, and apply imports with a preview as one undoable change.
- **Version comparison** (`compareVersions` in logic) matches items by id and reports added, removed, edited and minimally moved items, field by field.
- **Question library** (`library_items`, per organisation) stores an item, block or roster with the answer sets it uses. `insertFromLibrary` gives clashing ids and names fresh ones (updating references inside the entry) and reuses or renames answer sets.
- Interviews bind to a version (see _Interview runtime_); exports (slice 12) apply the stored mappings to line up data across versions.

## Cases, sample import and assignments

```
upload (CSV/XLSX) ─▶ sample_imports + staged rows ─▶ mapping ─▶ validation report ─▶ commit
                                                                                       │
             sample_fields (case.* dictionary, PII flags) ◀── created/updated ─────────┤
             cases + contacts + case_events ◀── inserted / updated in one transaction ─┤
             assignments (rules) ──── applied to the new unassigned cases ─────────────┘
```

- **Import** (`apps/api/src/cases`): `parseSampleFile` reads CSV (UTF-8 or Windows-1252, delimiter sniffed) or the first XLSX sheet; rows are staged in `sample_import_rows`. `suggestMapping` guesses the id, contact, priority and mode columns and the type and PII flag of other columns; `validateRows` checks ids (missing, repeated, already existing), e-mails, phones (normalised to E.164 with an optional default country code), numbers, dates, priorities and modes. Commit re-validates, creates or updates cases and contacts in batches, records `case_events`, applies the assignment rules and deletes the staged rows.
- **Cases API:** `GET /projects/:id/cases` pages, sorts, searches and filters (including rule expressions evaluated by the logic engine). People with `cases.read_assigned` only see cases assigned to them. Lists always mask personal sample fields; `GET …/cases/:caseId?reveal=pii` returns clear values to `pii.view` holders and writes `case.pii_viewed` to the audit log.
- **Assignment:** bulk assignment by list or filter to active members whose role can conduct interviews or key data; rules (`case.region == 1` → a person, with an optional quota) run oldest first on import and on demand.
- The designer offers the project's sample fields as `case.*` in conditions.
- **Project settings** (`projects.settings`, typed by `ProjectSettings`): whether interviewers see their own cases' personal data automatically (first view audited per case), and whether cases are assigned or taken from an open pool (`POST …/cases/:id/claim` with a conditional update, so concurrent claims cannot both win). Assignment rules run through `AssignmentStrategy` (`strategies.ts`), selected by `assignments.kind`.
- **Duplicates across projects:** validation looks up the file's normalised phones and e-mails in the organisation's other projects (index on `contacts(tenant_id, type, value)`) and adds a non-blocking `duplicate_elsewhere` issue with project names and row counts; the case drawer lists the other projects for people with `cases.read_all`. No matching value is ever returned.
- **Geocoding:** a `Geocoder` port (`apps/api/src/geo`) with a Nominatim adapter (identifying User-Agent, one request a second, cache by normalised address), chosen by `GEOCODER`. `POST …/geocode` geocodes the project's address contacts in the background (in this process for now) and records `cases.geocoded`; `GET …/geocode/status` reports progress. Coordinates sit on the contact and are masked with it. `GET …/cases-map` returns points (case id, status, coordinates) for the cases the caller may see; the web map uses Leaflet (bundled, loaded on demand) with OpenStreetMap tiles, plus the same points as a table.

## Interview runtime (slice 6)

```
InterviewRunner ─ change ─▶ useInterview ─▶ IndexedDB (snapshot + numbered outbox) ─▶ POST /interviews/sync
      ▲                          │                                                     │ acks per device
      └── session (logic) ◀──────┘ resume: server state, or the device copy if newer ◀──┘
```

- **Start** (`POST /projects/:id/interviews`): the device sends an id it made; the server binds the latest published version, stores the case data given to the engine, moves the case to _in progress_ (taking it in pool mode) and returns the compiled version and the server time.
- **Every change** in the runner is drained from the session (`drainEvents`), stamped with the interview clock and written to IndexedDB together with the engine snapshot, in one transaction, before the screen reports it. Navigation adds paradata (enter/leave question with time spent, back moves, pauses, focus, notes, language).
- **Sync** (`apps/web/src/interview/sync.ts`): every 3 s, when back online, and on hide/leave with `keepalive`; failures back off up to a minute. The server applies the run of changes that follows the last acknowledged number, stores answer events and paradata (append-only), and keeps the snapshot only when nothing was missed.
- **Submit**: once everything is acknowledged, the server replays the answers with the engine and finalises the case. The case drawer shows every answer change with who, when and why (path changes included).

## Telephone interviewing (slice 7)

```
Phone calls tab ─ N ─▶ POST /projects/:id/cati/next ─▶ queue (K1) ─▶ lock + open call ─▶ case, numbers, scripts
      │ 1–9, Ctrl+Enter
      ▼
POST /cati/attempts/:id/outcome ─┬─ answered ─▶ start CATI interview ─▶ interviewer screen ─▶ submit ─▶ hook closes the call
                                 ├─ final ─────▶ case finalised
                                 ├─ retry ─────▶ next_contact_at = now + delay
                                 └─ callback ──▶ next_contact_at = booked time (inside calling hours, respondent's zone)
```

- The shared interview runtime moved into `InterviewsService` (`apps/api/src/interviews/interviews.service.ts`): start, numbered sync, submit and case finalisation. Modes build on it; `onSubmitted` hooks let CATI close the call (and, later, CAWI mark the invitation and PAPI compare entries).
- Calls are stored in `call_attempts`; cases carry `attempts`, `last_attempt_at`, `next_contact_at`, `callback_user_id` and the call lock. Settings (`projects.settings.cati`): calling hours, attempts per case and retry delays, edited in the Settings tab.
- Scripts: `session.scriptsFor(anchor)` returns the questionnaire's scripts for the mode at an anchor (start, end, section, item, call outcome), piped with the case, respondent and interviewer. The calls tab shows the introduction and outcome scripts; the runner shows start, section and item scripts above the question in interviewer modes; the closing script appears before submitting.

## Offline face-to-face interviewing (slice 8)

```
My device page ─ download ─▶ POST /projects/:id/capi/checkout ─▶ IndexedDB: versions, cases, interviews
     │ offline: start / continue / submit (queued)                         │
     ▼                                                                     ▼
interviewer screen (device copy) ─▶ numbered outbox ─ online ─▶ POST /interviews/sync (start creates the interview)
                                                             └▶ POST /interviews/:id/submit ─▶ POST …/capi/checkin
```

- IndexedDB (`apps/web/src/interview/store.ts`, version 2) adds `versions` (compiled questionnaires by version id) and `cases` (downloaded cases with their state: ready, started, queued, done). A local interview can carry `meta` (what is needed to open it offline), `start` (sent until the server has created it) and `submit` (a queued submission).
- `apps/web/src/interview/device.ts`: download, start on the device, sync everything (changes, then queued submissions, then check-in of finished cases), give back.
- The My device page (`/projects/$projectId/device`) syncs on arrival, every 30 seconds and when the connection returns, and shows the connection, the last sync and what is waiting.
- The service worker is generated at build time by a small Vite plugin and registered in production builds only.

## Web surveys and e-mail (slice 9)

```
Web survey tab ─ create wave ─▶ POST …/waves ─ send ─▶ invitations (queued, token hashed + encrypted)
                                                          │ dispatcher (every 15 s, 200 per organisation)
                                                          ▼
                                           Mailer (console | file | SMTP) ─▶ respondent's inbox
                                                          │ click /t/c/:token ─▶ /s/:token (respondent page)
                                                          ▼
              GET /public/s/:token ─▶ CAWI interview ─▶ POST …/sync ─▶ POST …/submit ─▶ invitation completed
mail provider ─▶ POST /webhooks/mail (secret) ─▶ delivered / bounced ─▶ do-not-e-mail list (+ to CATI)
```

- Tables: `email_templates`, `waves`, `invitations`, `suppressions`, `open_links` (all under row-level security). Respondent links and webhooks find their organisation through security-definer functions that return only an id and a tenant.
- The respondent page (`apps/web/src/respondent/`) is outside the staff application: no sign-in, the questionnaire's language, pages on wide screens and one question per page on phones. Changes are kept in IndexedDB and sent after each page through the same numbered sync as interviewers'; navigation is recorded so the position reaches the server, and the server re-checks the path on submit.
- The funnel per wave counts sent, delivered, opened (approximate), clicked, started, completed and bounced, plus reminders.

## Paper forms (slice 10)

```
Paper forms tab ─ print ─▶ GET …/papi/forms ─▶ print page: cover (case id + QR) + PaperForm ─▶ browser print / PDF
                ─ key ───▶ GET …/papi/lookup?externalId= ─▶ POST …/interviews (mode PAPI, pass 1 or 2) ─▶ interviewer screen
submit (pass 2) ─▶ compare with pass 1 ─▶ entry_mismatches ─▶ supervisor resolves ─▶ reviewer answer event, case finished
```

- `interviews.entry_pass` tells the first and second entries apart; the start endpoint picks the pass (`PapiService.nextPass`) and refuses a second entry by the same clerk.
- The comparison runs in a submit hook; until every difference is resolved the case stays _in progress_.

## Answer review (slice 11)

```
submit ─▶ hooks: flags + sample (R2, R3) ─▶ review queue ─▶ review screen (engine rebuilt from state)
                                                   │ in review / approve / reject / return (comment)
                                                   ▼
                     returned ─▶ "Returned to me" ─▶ takeover on this device ─▶ fix ─▶ resubmit
correction ─▶ engine setAnswer + validate + walk the path ─▶ reviewer answer events (+ cleared)
```

- Interview columns: `flags`, `sampled`, `submitted_at`, `submissions`, `reviewed_by`, `reviewed_at`; tables `review_comments`, `open_codes`, `coded_texts`.
- The runtime accepts changes and submissions for interviews that are in progress or returned.

## Worker, metrics, dashboards and exports (slice 12)

```
API ── enqueue ──▶ Redis (BullMQ "wansurvey") ──▶ worker: mail.dispatch · stats.refresh · exports.build · stats.nightly
 ▲                                                   │
 └── SSE /projects/:id/live ◀── pub/sub project:<id> ◀┘ (after each stats refresh or export)
```

- `apps/api/src/jobs`: `JobsService` (BullMQ, or inline without `REDIS_URL`) and the bus (`RedisBus`, `LocalBus`). `src/worker.ts` starts the worker.
- `stats_daily` is refreshed per project and day; `MetricsService` reads it with grouped queries over interviews, calls and cases, then applies `metrics.ts`.
- `DatasetService` reads a questionnaire's submitted interviews (any filter) against its latest version; `packages/exporters` turns them into tables (`buildTables`), toplines and crosstabs, and CSV, SPSS, Stata and zip files; Excel and the codebook use exceljs.
- Exports are rows in `exports` with the file (bytea); share links resolve their organisation through a security-definer function, like respondent tokens.
- Web: project tabs Dashboard (EventSource), Metrics, Results (topline, crosstab, client links) and Exports; `/projects/:id/summary` prints; `/share/:token` is public.

## Hardening (slice 13)

- Personal sample fields: `CasesService.pii` (`PiiCipher`) seals on write and opens on read; `PrivacyService` seals leftovers (`pii.encrypt`), applies retention (`privacy.retention`) and answers data subject requests (`PrivacyController`). Erasing answer history goes through `erase_interview_history()`, the only exception to append-only history.
- Headers: the API sets its own; the web app's are in `apps/web/security-headers.ts` (vite preview) and `infra/nginx/templates/default.conf.template` (production).
- Project settings `shortcuts` reach the interviewer screen in the interview payload and in downloaded CAPI cases.
- Docs: [`operations.md`](operations.md), [`security.md`](security.md) (ASVS L2), [`accessibility.md`](accessibility.md), [`acceptance.md`](acceptance.md).
