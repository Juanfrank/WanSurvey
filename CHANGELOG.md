# Changelog

All notable changes to WanSurvey are written here, for the people who run it and the people who
use it. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the
versions follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html); what counts as
the public interface, and how a release is made, is in [`docs/releasing.md`](docs/releasing.md).
Planned work is in [`docs/roadmap.md`](docs/roadmap.md).

Entries are written by hand, grouped by what changed for the reader, and say what to do when an
upgrade needs action (**Upgrade** notes). They are not a list of commits.

## [Unreleased]

## [0.1.0] - 2026-11-05

The first tagged release. Before 1.0.0 the interface may still change between minor versions
(see the versioning policy); every such change is listed here.

### Added

- **Platform and security.** Several organisations in one deployment, isolated by row-level
  security on SQL Server; accounts that belong to several organisations; password sign-in
  (Argon2id) and Microsoft Entra ID sign-in, cookie sessions with CSRF protection, TOTP two-factor
  authentication, rate limiting, roles and customisable role permissions per organisation, an
  append-only audit log with its own export, encrypted personal fields with audited reveal,
  retention with anonymisation, and data subject export and erasure.
- **Questionnaires.** A schema and an expression language with routing, validation and piping; a
  keyboard-driven designer with a visual condition builder, scripts, quotas, mode variants,
  translations (CSV and XLIFF), comments, a question library, light co-editing, version
  comparison and immutable published versions with publish checks.
- **Fieldwork in four modes.** Telephone (CATI) with a call queue, callbacks and AAPOR
  dispositions; face to face (CAPI) as an installable app that works offline; web (CAWI) with
  e-mail invitations, reminders, open links and per-case links; paper (PAPI) with printable forms,
  keying with double entry, and automatic reading of scanned forms (OMR).
- **Cases and assignments.** Sample import from CSV and Excel with a validation report,
  assignment rules with quotas, sampling designs, expiry, duplicate detection and geocoding.
- **Quality and review.** A review workflow with quality flags, a random sample and comments per
  question; a fraud-risk score from short answers, position clusters and distance to the address;
  optional audio recording of face-to-face interviews, off by default, in a private container.
- **Results.** Live dashboards, interviewer metrics, topline and crosstabs, read-only client
  links, a printable summary, exports to CSV, Excel, SPSS, Stata and SQL with a codebook, and an
  analysis model (schema `bi`) for BI tools.
- **Integration.** A read-only integration API with keys per organisation
  (`/api/v1/ext/v1`), outgoing webhooks with signatures, an SMS channel for web surveys, and web
  notifications for interviewers and supervisors.
- **Interface.** Spanish by default with English available; light and dark themes, with a default
  and an accent colour per organisation from a contrast-checked palette; WCAG 2.2 AA audit.
- **Operations.** Deployment as a zip to one Azure App Service (API, web and worker), a Bicep
  template, background jobs with or without Redis, a health endpoint, k6 load tests for CAWI,
  CATI and CAPI (`load/`), and the guides in `docs/`.

### Changed

- SQL Server (or Azure SQL) is the only database. The data layer is Kysely with tedious and the
  migrations are T-SQL. Instants are stored with millisecond precision.
- Settings have one set of names; the former names stop the application at start instead of being
  read as aliases. **Upgrade:** rename them as in `apps/api/.env.example`.
- The Microsoft sign-in callback is `/api/auth/entra/callback`, the same in every app;
  `/api/v1/auth/sso/callback` was removed. **Upgrade:** register the new redirect URI in Entra.
- There is no default organisation: the organisation comes from the e-mail's directory.
  **Upgrade:** set `INITIAL_ADMIN_USER` to create the first administrator.

### Removed

- PostgreSQL support, Drizzle and the PostgreSQL migrations. The copy tool that moved data from
  PostgreSQL is in the git history (`docs/data-copy.md`).

### Security

- Strict Content-Security-Policy and security headers; the OWASP ASVS level 2 checklist is in
  `docs/security.md`. Dependencies are taken when they are two weeks old, apart from security
  fixes, and the build fails on a moderate or higher advisory.

[Unreleased]: https://github.com/Juanfrank/WanSurvey/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Juanfrank/WanSurvey/releases/tag/v0.1.0
