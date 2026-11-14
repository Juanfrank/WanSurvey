# Changelog

All notable changes to WanSurvey are written here, for the people who run it and the people who
use it. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the
versions follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html); what counts as
the public interface, and how a release is made, is in [`docs/releasing.md`](docs/releasing.md).
Planned work is in [`docs/roadmap.md`](docs/roadmap.md).

Entries are written by hand, grouped by what changed for the reader, and say what to do when an
upgrade needs action (**Upgrade** notes). They are not a list of commits.

**Every version so far is an alpha** (`0.1.0-alpha.N`): features are still arriving and the
interface may change between any two of them. Alphas up to `0.1.0-alpha.18` were **reconstructed
on 2026-11-05 from the git history**: nothing was numbered or deployed as a release at the time,
and each tag marks the commit that closes a stage of the work, with that commit's date. From
`0.1.0-alpha.19` on, versions are made as described in `docs/releasing.md`.

## [Unreleased]

### Added

- **About, Privacy and Terms follow the institution's common schema** (`docs/info-pages.md`): shared
  types in `@wansurvey/schema`; About in a fixed order (`what`, `who`, `version`, `rights` if there is an
  author or holder, `access`, `contact`, `documents`, and `technical` for people with a session); only
  the services that are on are claimed; no changelog or accessibility claim in the public text; a
  language selector and a Back link; inside the application's frame for people who work in it. New
  `GET /api/v1/system/technical` (session only) and the setting `APP_BUILD`.
- **Author and holder on the About page**: an "Authorship and ownership" section, separate from the
  organisation that runs the installation. The author (Juan Francisco Medina, Gerencia de Ciencia y
  Analítica de Datos) is fixed in the project; `APP_HOLDER` (optional) adds the holder of the rights.
- **Installation wizard** (`/setup`): while `DATABASE_URL` is not set the API runs only a wizard instead
  of failing. It asks for the SQL Server address, database, schema and the user names (never a
  password) and gives two copy-and-paste SQL scripts, (1) the tables and (2) the users and permissions,
  plus the settings for the environment. `db:script --part tables|users` makes the same two files.
- **`db:script`: one `.sql` file with the schema, users, tables, security and grants**, with your names in
  it, for a DBA who wants to read and run it with `sqlcmd` (`--users-by-dba` for users made beforehand,
  `--from` for an upgrade). One transaction; passwords are `sqlcmd` variables. See `infra/sql/02-migrate.md`.
- **`DATABASE_MANAGE_USERS=false`: the DBA makes the SQL users** (contained or from logins) and the
  migrations only make the schema and the tables and grant the permissions to them: no user,
  password, containment or server setting is created or changed. They stop with a clear message if a
  user is missing or its default schema is not `DATABASE_SCHEMA`. Described in `infra/sql/02-migrate.md`.
- **`01-existing-database.sql`** for a database that already exists: it creates nothing, turns on
  contained users if they are off, and leaves or changes the owner of the database as you say. The
  migrations no longer ask the owner for server permission when contained users are already on.
- **Scripts to make and check the SQL users by hand** (`infra/sql/03-users.sql`,
  `04-check-permissions.sql`, `05-drop-users.sql`): the schema, the read/write and read-only users
  with the names you choose, a read-only check of their permissions against the least-privilege
  rules, and removal of the reader. Described in `infra/sql/02-migrate.md`.
- **Creating accounts on the first Microsoft sign-in is a choice of each organisation** (Organisation
  page, `autoProvision` in `PUT /tenant/sso`, default yes, as before): the person gets an account and a
  membership with no role. When off, only people already added or invited get in; others are refused
  with `not_provisioned`. `ENTRA_AUTO_PROVISION=false` in the deployment forbids it for all. New
  migration `0029_sso_auto_provision.sql`.
- **Suggestions while writing expressions**, as in a code editor: in the designer's formula,
  prefill, option-filter and similar fields, and in the cleaning rules of a project, a drop-down
  offers the questionnaire's variables (with their question text), the sample fields as `case.x`,
  the context names, the functions of the language (with what each does) and its keywords. It
  opens as you type or with Ctrl+Space; up and down choose, Enter or Tab take, Escape closes. A
  function is inserted with its brackets and the cursor inside.
- **Link builder in the web outreach** (Difusión): under the open link and under the personal
  links of a "links only" outreach, it lists the questions that take a link parameter, offers the
  values each accepts (options, scale range, number, date), marks a value the survey would drop,
  shows the address live with Copy and Try it, and can make **one address per value of a question**
  (a link per branch or group) with the other parameters on all, as a table or a CSV.
- **Pre-filled answers, clearer**: the three uses are named as the area states them: confirm what
  is known and ask what is missing; collect only what is missing; only bring it into the results.
  A question whose answer is still the one that came from the sample says so ("Already known from
  the sample: confirm it or correct it").
- **People registry and no contact** ([ADR 0002](docs/adr/0002-people-registry-and-no-contact.md)):
  Administration → People registry shows what the organisation knows of a phone or e-mail (its
  participations and its no-contact entry), holds the **no-contact list** (per contact, for every
  channel or some, permanent or until a date, with the reason) and loads two CSV files: the list
  (including people marked not interested or not to be contacted) and the **history** of
  participations since 2020. New tables `no_contact` and `participations` (migration `0026`),
  permissions `registry.read` and `registry.manage`, and audit actions
  `registry.no_contact_added`, `registry.no_contact_lifted`, `registry.history_loaded`.
- **"Do not contact again"** as a call outcome: every phone and e-mail of the case goes on the list
  for every channel, for the time the project sets (permanent by default), and the case closes as a
  refusal; it is also allowed when an answered call is closed early.
- **Contacting people again**, in the project's cleaning settings: an exclusion period (days, and
  which channels count) and how long a "do not contact" from a call lasts. The call queue skips
  people on the list for the phone channel, web invitations (e-mail and SMS) are not sent to them,
  and a list being loaded reports and leaves out whoever is on the no-contact list
  (`no_contact`) or took part inside the exclusion period (`recent_participation`).
- **The early-exit reason** is in the analysis model (`motivo_salida` in `fact_envio` and `plano_respuestas`, migration `0027`) and in every export as the column `exit_reason`, after `disposition`.
- **Face-to-face downloads** skip cases whose person is on the no-contact list for that channel (`NO_CONTACT` in the refused list of the checkout).
- The registry's two loads read **Excel (.xlsx, first sheet)** as well as CSV, by column name.
- An interview of a case that is submitted records the participation of every phone and e-mail of
  the case, by channel, in the registry. Erasing a person removes their participations and keeps
  their no-contact entry.
- **Refresh frequency of the analysis model** in Administration → Organization: every 15 minutes up
  to once a week, never (on request only), or as the deployment's `BI_REFRESH_CRON` sets it, with a
  "Refresh now" button and the time of the last check. The model spans every organisation, so the
  setting is the installation's; who manages an organisation sets it and the audit log records it
  (`app.bi_frequency_changed`). New table `app_settings` (migration `0025`) read and written only
  through owner procedures. A job wakes every ten minutes to honour it.
- **Early-exit reasons** for telephone interviews: each project has a list of reasons (generic ones
  by default, in Spanish and English, editable in Settings → Phone), the call workspace asks for one
  when an answered call is closed as interrupted, and the project can make it required. The reason
  is kept on the interview and in the case history. Web and face-to-face interviews do not have it
  yet.
- **Callbacks**: a button to make a callback the next case the caller is served (even before it is
  due; calling hours still apply), and a bubble in the callbacks panel that turns the browser
  notice for callbacks on and off.

- **Person identified wrongly in the original record**: from a case, a supervisor marks that the
  person reached is not the one of the record, with what happened. The case closes as not eligible
  (a new result, _MISIDENTIFIED_) and the interviews made with that person are rejected with the
  note, so no report counts them; the days involved are recomputed and the history keeps the state
  before.

- **Time to work a case in hours**: the deadline after assignment (for example 48 hours) is set in
  hours or in days, and hours win when a project has both.
- **Changing the list of a sample**: a batch is sized with the confidence and margin chosen for it,
  which are kept with it (the area changes them when it adds each sample, not for the whole
  project), and **Replace the list** withdraws the cases nobody has worked and brings a new batch.
  Adding and substituting a case were already there.

- **Approval before publishing**: a project can ask for a draft to be approved before it is
  published. The author asks for the draft as it stands, someone else with the new permission
  _Approve questionnaires for publishing_ (project managers have it by default) approves it or
  says what to change, any later change to the draft needs a new request, and a publish uses up the
  approval. The steps and who approves are still one level; more can be added later.
  **Upgrade:** a custom role matrix does not have the new permission until it is given.
- **Similar questions**: in the question editor, a button lists questions worded alike in the
  organisation's other questionnaires and its library, to avoid asking the same thing twice and to
  reuse wording. Linking similar questions to one another is still to do.

- **Cleaning a list as it is loaded** (Settings → Cleaning): text columns tidied (no double
  spaces or invisible characters, optionally no symbols); saved **rules** that leave rows out,
  written over the columns of the file and counted by rule in the import report; the **same
  person twice in a file** found by the fields the project chooses, reported or left out; and a
  new `matches(text, pattern)` function in the expression language, with a regular-expression
  engine that cannot be slowed down by a hostile pattern. Everywhere expressions are written
  (rules, assignment, sampling, questionnaires) can use it.
- **Withdraw several cases at once** from the case list, with one reason for all.

### Changed

- The web sendings are called **Difusión** (outreach) in the interface instead of _Campañas_; the
  area's own name for them. Nothing changes in the API (`waves`).
- `docs/bi.md` describes SQL Server (it still described PostgreSQL): the tables of the model,
  the refresh, and how to make a read-only analysis user.
- The analysis model's refresh also refills the dimensions of the hierarchy, and its fingerprint of
  changes covers their sources. **Upgrade:** the migration (`0022`) fills them; nothing to do.
- **Free-text questions fed by the link**: a text question with a link parameter is filled from
  the URL (encoded value, up to its maximum length or 500 characters; longer values are cut).
  The link builder checks length, pattern and e-mail/phone format, and warns that the value is
  visible in the address. The server keeps up to 500 characters per parameter and masks `params`
  in its logs.
- **Short link with the answers already given**: `POST /projects/{id}/open-link/prefilled` takes
  the answers as plain JSON values by link parameter (`{"answers":{"nombre":"María José"}}`, no
  URL encoding) and returns a short link whose interview already holds them, so nothing personal
  shows in the address. The link builder offers it as "Make short link" under the open link.
  Names no question takes are refused with the list of valid ones.

- **Link with a value left for another system**: in the link builder, a question can be marked
  "filled in by another system"; the address then ends `?codigo=<codigo>` (also on every
  personal link of a "links only" outreach), and the system swaps the placeholder for each value.
- **About and Privacy Policy pages** (`/about`, `/privacy`), public and in Spanish and English:
  what the application is, and what data it handles about people who answer and people who use it,
  why, who receives it, cookies and storage, retention, rights and security. They name the
  organisation and contact from the new `ORG_NAME` and `PRIVACY_CONTACT` settings, and mention
  only the outside services that are switched on (`GET /public/about`). Linked from sign-in, the
  account menu and the foot of web surveys. The text needs the institution's legal review.
- **The schema and the database users have the names you choose**: `DATABASE_SCHEMA` (default
  `dbo`) puts the tables, procedures and views in another schema, such as `survey`; the application
  user is the one in `DATABASE_URL` (no longer always `wansurvey_app`); and `DATABASE_READONLY_URL`
  makes a user that reads only the analysis model (schema `bi`), with explicit refusals on the rest.
  The application names no schema in its queries: its user has the schema as default. Choose them
  before the first migration. The provisioning scripts in `infra/sql/` and `02-migrate.md` follow.
  The seed and demo data (`pnpm db:seed`, `db:seed-demo`) and the load setup work in whatever
  schema `DATABASE_SCHEMA` names: the owner's connection names it in the statements (`createOwnerDb`).
- **Terms of use and confidentiality undertaking** (`/terms`, public): everyone who works in the
  application must read and accept them before using it, once per version of the text; the
  acceptance is kept with its version and date (`users.terms_version`, migration 0028) and in the
  activity log (`user.terms_accepted`). Raising `TERMS_VERSION` asks everyone again. The demo
  accounts come already accepted. The text needs the institution's legal review.
- **E-mail opens can be switched off** (project settings → Web): without the invisible image the
  funnel shows no opens, only clicks and starts; the personal link still works. On by default, as
  before.
- **Share links always end**: a link to a project's summary is valid for at most 90 days (30 by
  default) and can no longer be "until revoked". Links already made keep their date.
- **Sensitive data and minors**: a question can be marked as special-category data (health, racial
  or ethnic origin, political opinions, religion, sexual orientation, trade-union membership,
  biometric or genetic data, judicial record). It is stored as personal data too (masked, encrypted,
  left out of exports without permission), and a questionnaire with one cannot be published without
  the information notice. A project can set a **minimum age**: the designer then offers an **Age
  screen** (a question about age that ends the interview as not eligible under that age) and the
  questionnaire cannot be published without it (`AGE_SCREEN_REQUIRED`).
- **Lawful basis for calling and visiting** (project settings → Privacy): one for telephone calls
  and one for face-to-face visits. Until a channel's basis is declared, no call is served, no
  interview of that channel starts and no case is downloaded to a device (409 `NO_LAWFUL_BASIS`),
  as e-mail and SMS already behaved. **Existing projects that call or visit are blocked until they
  declare it.**
- **Information notice as part of the questionnaire**: the notice is the questionnaire's first
  question, with the same look, language and engine as any other: a consent text and the question
  that accepts or refuses, which ends the interview as a refusal. The designer adds the standard
  pair with the **Information notice** button (to complete with the organisation, the purpose and
  the contact, in every language). It is translated, previewed, printed on paper and exported like
  any item, and its version is the questionnaire's. A project can **require** it (Settings →
  Privacy): a questionnaire that does not open with it cannot be published
  (`NOTICE_REQUIRED`, and the publish check says so).
- **Retention period for new projects**: a new project starts with 365 days before the personal
  data of finished cases is removed, and the settings screen warns when no period is set. Existing
  projects are not changed.
- **Legal and compliance review** (`docs/legal-risk-review.md`): what can bring civil, penal or
  administrative liability to the owner, manager or contracting party, by priority, with the
  evidence in the code, what to do and who does it.

### Fixed

- A web respondent was shown the questions already answered by the link (`?sede=2`) or filled from
  the sample in the "only bring it into the results" mode, although they were meant to be recorded
  and not shown. They now stay out of the pages; the logic still follows them.
- An analysis user with read access to the `bi` schema saw no rows in the dimensions of
  organisations, projects, instruments, versions, cases and people, or only part of the calendar,
  because they were views under the row-level security of the organisation's tables; a joined
  query, such as the SQL export, came back empty. They are tables now, filled like the rest.
- The theme test of the browser suite waits for the sign-in page before checking it.
- The Privacy Policy no longer says that web surveys record the device position (only interviews
  with an interviewer do, when the project turns it on) nor that every project has a retention
  period (none is set by default); it also informs staff about position, voice and quality
  indicators.

## [0.1.0-alpha.19] - 2026-11-05

### Added

- One product version for the whole repository, checked in CI together with this file
  (`pnpm release:check`), and `pnpm release` to cut a release: alpha, beta, release candidate or
  final.
- The versioning policy, the commit convention and the release steps (`docs/releasing.md`), a
  pull request checklist, and the roadmap rewritten as Now, Next and Later with the conditions
  for 1.0.0 (`docs/roadmap.md`).
- The API reports its version in the OpenAPI document (`/docs`) and in the start-up log.

## [0.1.0-alpha.18] - 2026-11-03

### Added

- **Outgoing webhooks** for the integration API: signed deliveries kept in the database with
  retries, a screen to manage them, and a check that the address is not an internal one.
- **SMS channel for web surveys**: invitation and reminder waves by SMS with a preview before
  sending, and replies and opt-outs handled.
- **Interview audio** for face-to-face interviews, off in every project: a share of the interviews
  is recorded in 30-second files on the device after the respondent consents, sent to a private
  container, listened to with a permission that is audited, and deleted with the retention job or
  an erasure.
- **Web notifications** (Web Push): people choose, per browser and category, what to be told:
  callbacks about to be due, new assignments, an interview returned, an export ready.
- **Organisation theme**: a default (light, dark, system) and an accent colour from a palette
  whose contrast is checked in both themes; a person's own choice always wins.
- **Load tests** for web, telephone and tablet interviewing with k6 (`load/`), with a script that
  makes the accounts and cases on SQL Server.

## [0.1.0-alpha.17] - 2026-11-02

### Added

- **Audit log export** with its own permission, a test that every table with an organisation
  column is under row-level security, and a scan that finds personal data left after an erasure.
- **Fraud-risk score** of submitted interviews from short answers, clusters of positions and the
  distance to the address, shown in the review queue.
- **Integration API**, read only, with keys per organisation under `/api/v1/ext/v1`
  (`docs/integration-api.md`).
- A disposable development database on a SQL Server you run (`db:dev`), and a development zip that
  starts its own SQL Server in Docker.
- The decisions for the next stage, recorded in ADR 0001.
- `INITIAL_ADMIN_USER`: the first administrator, by UPN, signs in with Microsoft.

### Changed

- There is no default organisation: the directory is the deployment's and the organisation comes
  from the e-mail's domain. **Upgrade:** set `INITIAL_ADMIN_USER` on a new installation.
- Code-quality findings from SonarQube: sort comparators, linear regular expressions, test
  assertions and accessibility.

### Fixed

- The first local day was missing from the analysis model's date dimension.

## [0.1.0-alpha.16] - 2026-11-01

### Changed

- Settings have one set of names, and the former names stop the application at start instead of
  being read as aliases. **Upgrade:** rename them as in `apps/api/.env.example`.
- The Microsoft sign-in callback is `/api/auth/entra/callback`, the same in every app of the
  organisation; `/api/v1/auth/sso/callback` was removed. **Upgrade:** register the new redirect
  URI in Entra.
- Major dependency updates, one at a time: Vitest 4, Playwright 1.64, pino 10, tedious 20,
  BullMQ 6 and ioredis 6, NestJS 12, ESLint 10, React 19, Vite 8. ExcelJS is replaced by hucre.
- Node 24.22.2, the security release, in CI, the images and `.nvmrc`.
- Comments describe SQL Server as it is, no react-hooks lint warnings are left, and unused code
  and parameters are gone.

### Fixed

- A web survey sends again when a send under way left changes unacknowledged.

### Security

- Updates of `body-parser`, `multer`, `follow-redirects` and `uuid`; `jose` is pinned. The
  dependency audit now covers development tools, at moderate severity.

## [0.1.0-alpha.15] - 2026-10-31

### Changed

- **SQL Server (or Azure SQL) is the only database.** Every module reads and writes through a
  repository with a SQL Server implementation, the migrations are T-SQL, isolation by organisation
  is a security policy on `SESSION_CONTEXT`, and instants have millisecond precision.
  **Upgrade:** an installation on PostgreSQL moves its data with the copy tool of this version
  (`docs/data-copy.md`; no production data existed when it was written).
- The API tests that need a database run on SQL Server over HTTP, for every module and every role,
  and so do the browser tests, each with its own CI job.

### Removed

- PostgreSQL, Drizzle, the PostgreSQL migrations and test suite, and the k6 scripts written
  against them.

### Fixed

- Accessible names that contain the visible text (label in name), found with axe-core 4.14.

### Security

- `nodemailer` 10.1.4 closes three moderate advisories in its address parser.

## [0.1.0-alpha.14] - 2026-10-30

### Added

- A SQL Server data layer (Kysely with tedious) and an isolation kernel in T-SQL, built vertical
  by vertical with tests: questionnaires, cases and sampling, interviews and CATI, review, web
  surveys and e-mail, paper, statistics and exports, the analysis model (`bi`) filled by owner
  procedures with its T-SQL export, teams, the audit log, identity, sessions and one-time tokens,
  people, organisations and projects.
- A test that every PostgreSQL column exists in the T-SQL migrations.
- `ENTRA_REDIRECT_URI`, and `/health` restricted by `HEALTH_ALLOWED_IPS`.

### Removed

- `API_PUBLIC_URL`.

## [0.1.0-alpha.13] - 2026-10-26

### Added

- **Deployment to Azure App Service from a zip**: one Node process, one instance, no containers
  and no Redis; jobs run in the API with retries, scanned paper forms are read with a pure-Node
  PDF renderer, and migrations run when the application starts.
- Settings templates for development and production, and `appconfig/` for the confidential files
  kept out of the repository.

### Changed

- Node 24 LTS.

## [0.1.0-alpha.12] - 2026-10-24

### Added

- One App Service on Premium v3 (P0v3) with the web, the API and the worker as sidecars, and its
  Bicep template.
- Exports streamed page by page to Azure Blob Storage, so a large export does not need memory.
- Load tests with k6 for web respondents and sign-in at the start of the day, with server-side
  measures; capacity work moved the point where the web survey stops keeping up from 47 to 72
  completes a second (fewer statements per request, shedding by priority, one transaction per
  respondent request).

### Changed

- Sign-in with the Microsoft button only, when the deployment asks for it.
- Personal data stays behind `pii.view` in exports, case filters and the map, and an erasure
  removes every copy.
- The logic engine and the designer were hardened after a review (checks, edge cases of the
  expression language), and so were sign-in, sessions and SSO, sampling weights, share-outs,
  double entry and goals.
- Redis outages never hold requests, lost jobs are retried and e-mail is sent once; transactions
  are short and the analysis model refreshes when data changes.
- Accessibility: errors, focus, contrast, page titles and reflow.
- Lockout after failed sign-ins, one-use codes, a blocking audit, and smaller files.

### Security

- No account takeover through Microsoft sign-in: an identity is linked to an existing account by
  e-mail only when the account belongs to that organisation alone, or its owner is signed in with
  password and second factor; a domain can belong to one organisation only.
- SQL and CSV exports and the import report keep formula-like text as text; names in the SQL
  export cannot break out of their comment; request URLs and the console mailer no longer put
  tokens or message text in the logs; web respondents get only the case fields the questionnaire
  reads; redirect addresses must be http(s).

## [0.1.0-alpha.11] - 2026-10-17

### Added

- **Administration** in the side panel: users, teams, organisation and audit log; a People tab in
  each project to see and change who works on it; projects as a submenu.
- **Customisable role permissions** per organisation, with a guide to each role; interviewers can
  key paper forms.
- **Reading scanned paper forms**: PDFs of any number of forms, in any order, are split, aligned
  and read; what a machine cannot read reliably is left for a second round by hand.
- Share-out of cases by capacity, by performance, and fair with a ceiling, with a preview; goals
  by frequency (day, business days, week, month, period), per person or for the team.
- Questionnaire actions: disable, enable again, complete (with a continuation) and reopen.
- The **analysis model** (schema `bi`), a snowflake and a flat table over every project,
  questionnaire and feedback point, with paradata; and an SQL export that reproduces the Excel
  one from it.

## [0.1.0-alpha.10] - 2026-10-17

### Added

- A team page: invite people, roles per project, deactivate and reactivate.
- Cases belong to questionnaires; a case list per questionnaire with figures, assignment dates
  and the rules behind a gear; questionnaires in two-level tabs; project settings by topic.
- Case deadlines, sample batches that add to the sample, goals per interviewer and eligibility
  checks across cases.
- Project logos and the style of the web survey.

### Changed

- Web survey waves are called campaigns (_Campañas_); callers land on their calls; the pages use
  the width of the screen.

## [0.1.0-alpha.9] - 2026-10-16

### Added

- **Quick feedback**: faces by link, a widget and printed slips, created with the questionnaires.
- A sampling selector in place of the sample import, with a census that sizes itself from the
  eligible frame and a note on every term.
- Paper forms for form readers (circles, character boxes, a grid annex, approximate dates) and for
  scanners (form bands, question anchors, special answers as circles).
- Personal web survey links per case, without e-mail; case data and link parameters can answer
  questions, and are kept on the server with the interview.
- Designer: a grouped type menu with icons, split add buttons, a context menu, an assistant for
  `{{`, scripts per item, flow previews, a logic check, and a preview as seen in the field.
- Interviews: routes beside the answers, searchable choices, typed grids and rankings.
- Likert points with follow-up questions; project tabs in working order.
- An end-to-end journey test across the modes.

### Changed

- The web survey downloads 151 KB instead of 239 KB.

### Fixed

- The daily chart, scales with optional colours, clearing a radio button, and Ctrl+Enter in text
  answers.

## [0.1.0-alpha.8] - 2026-10-13

### Added

- Deployment to Azure App Service (S1) with a managed PostgreSQL.
- Questionnaires take their modes (CATI, CAPI, CAWI, PAPI) when they are created.
- A new visual style (Poppins, blue and navy), a collapsible side panel with an account badge,
  and a dark mode that follows the person's choice or the device's.
- The callbacks list says who, why and whether, and a callback can be called now.
- Many users at once: connection pools, timeouts, retries, load shedding and limits shared between
  processes.

### Changed

- Every visible text is in the interface language.

### Fixed

- Sync never sends changes without their snapshot.

## [0.1.0-alpha.7] - 2026-10-13

### Added

- **Answer review**: statuses (in review, approved, returned with comments, rejected), a queue with
  quality flags and a random sample, a review screen with timings and comment threads per
  question, corrections that re-run the logic, and coding of "other" answers.
- **Results**: a background worker (BullMQ, Redis), a live dashboard, interviewer metrics with
  AAPOR rates and outliers, topline and crosstabs, a printable summary, read-only links for
  clients, and exports to CSV, Excel, SPSS, Stata and a codebook.
- **Hardening**: a keyboard-only web survey with 44 px targets and 200 % zoom, a strict
  Content-Security-Policy, encrypted personal fields, retention with anonymisation, data subject
  export and erasure, a bundle budget, k6 scripts, and the operations, security (ASVS level 2)
  and accessibility guides.

## [0.1.0-alpha.6] - 2026-10-12

### Added

- **CATI**: a call queue with callbacks first and locks so no case is served twice, calling hours
  in the respondent's time zone, outcomes mapped to AAPOR dispositions with retries, scripts, and
  a keyboard-first Phone calls workspace.
- **CAPI offline**: an installable app with a service worker, cases downloaded to one device,
  interviews started, continued and submitted without a connection, optional location, and a
  supervisor release of a lost device.
- **CAWI and e-mail**: invitation and reminder wording with preview, waves with reminders, tracking
  of opens and clicks, bounces, do-not-e-mail list, unsubscribe, and the phone-friendly,
  resumable respondent survey plus open links.
- **PAPI**: printable forms per case with a QR code, keying by clerks, and double entry with a
  list of differences for a supervisor.

### Fixed

- A submission waits until every change has been acknowledged.

## [0.1.0-alpha.5] - 2026-10-12

### Added

- **Interview runtime**: an interviewer screen with case details, section navigator, notes and
  pause; answers kept on the device and synced in numbered, idempotent batches; "Saved" only when
  the server has them; paradata; a server-checked submission and the answer history of each case.
- Questionnaires are written in Spanish and other languages are edited one at a time; the
  interface is in Spanish by default, with English available.

## [0.1.0-alpha.4] - 2026-10-12

### Added

- **Cases and assignments**: CSV and Excel sample import with column mapping and a validation
  report, a case list with filters, bulk assignment, assignment rules with quotas, case history,
  and personal data masked with audited reveal.
- Per-project settings: automatic personal data for interviewers, and an open pool of cases.
- Designer: drag and drop, translation export and import (CSV, XLIFF 2.0), version comparison,
  comments on items, a question library, and light co-editing (presence and three-way merge).
- Geocoding with OpenStreetMap, a case map, and duplicate detection across projects.

### Changed

- Stricter publish checks, restored prefill, and engine and server messages translated.

## [0.1.0-alpha.3] - 2026-10-12

### Added

- **Questionnaire designer**: projects and questionnaires, a keyboard-driven outline, editors for
  every item type, mode variants, scripts, quotas, a visual condition builder with nested
  conditions, a routing map, and autosaved drafts with conflict detection.
- Publishing with checks (errors, saved scenarios, breaking-change mapping) into immutable
  versions.

## [0.1.0-alpha.2] - 2026-10-12

### Added

- The questionnaire **renderer**: every question type in all four modes (paper as a print-style
  form), operated by keyboard, in English and Spanish.
- The web app: sign-in with password and Microsoft, the organisation switcher, the waiting-for-
  access page, and a designer preview with a path tracer and saved test scenarios.
- Browser tests (Playwright) and CI.

## [0.1.0-alpha.1] - 2026-10-12

### Added

- The monorepo, with a Zod questionnaire schema and a logic engine: expression parser and
  evaluator, routing, validation, piping and static analysis.
- API foundations: several organisations in one database isolated by row-level security, password
  sign-in (Argon2id) with cookie sessions, CSRF protection and rate limiting, TOTP two-factor
  authentication, roles, and an append-only audit log.
- Accounts that belong to several organisations, and Microsoft Entra ID sign-in.
- A fixtures package with a scenario runner and translatable checks.

[Unreleased]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.19...HEAD
[0.1.0-alpha.19]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.18...v0.1.0-alpha.19
[0.1.0-alpha.18]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.17...v0.1.0-alpha.18
[0.1.0-alpha.17]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.16...v0.1.0-alpha.17
[0.1.0-alpha.16]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.15...v0.1.0-alpha.16
[0.1.0-alpha.15]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.14...v0.1.0-alpha.15
[0.1.0-alpha.14]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.13...v0.1.0-alpha.14
[0.1.0-alpha.13]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.12...v0.1.0-alpha.13
[0.1.0-alpha.12]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.11...v0.1.0-alpha.12
[0.1.0-alpha.11]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.10...v0.1.0-alpha.11
[0.1.0-alpha.10]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.9...v0.1.0-alpha.10
[0.1.0-alpha.9]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.8...v0.1.0-alpha.9
[0.1.0-alpha.8]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.7...v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.6...v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.5...v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.4...v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/Juanfrank/WanSurvey/releases/tag/v0.1.0-alpha.1
