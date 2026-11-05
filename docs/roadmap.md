# Roadmap

What is planned and why. It is a statement of intent, not a promise of dates: items are ordered
by how soon we expect to take them (**Now, Next, Later**), and each says the outcome it is for.
What has shipped is in [`CHANGELOG.md`](../CHANGELOG.md); how versions are numbered is in
[`releasing.md`](releasing.md).

**Where we are:** 0.1.0, the first tagged release. Everything described in the README is built
and tested; what is left is proving it in the field, closing open decisions and keeping the
dependencies current.

## Now: 0.2.0, ready for real fieldwork

Outcome: an organisation can run its first survey wave on the production deployment and we know,
by measurement, that it holds.

| Item                                  | Why, and what it takes                                                                                                                                                                                                                                                                                  | State |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Load measured on Azure SQL            | The k6 scenarios exist (`load/`); the targets (300 interviewers, 50 web completes a second, p95 under 800 ms) are not yet measured on the real tier. Run them, size `DB_POOL_MAX` and `DB_WORKER_POOL_MAX` ([`concurrency.md`](concurrency.md)), record the numbers in [`acceptance.md`](acceptance.md) | open  |
| Interview audio: legal sign-off       | Legal basis, consent wording, retention and who may listen are for the institution's legal area ([`operations.md`](operations.md)); it stays off until agreed. Then a test on real tablets (battery, storage, long interviews)                                                                          | open  |
| SMS: run the adapter on a real number | The Azure Communication Services adapter is covered by tests against a stand-in, not against the service                                                                                                                                                                                                | open  |
| Webhooks: tell administrators         | An endpoint disabled after repeated failures only shows in the screen; an e-mail to the organisation's administrators is not built                                                                                                                                                                      | open  |
| Web notifications: "wave finished"    | The category was left out of the first version                                                                                                                                                                                                                                                          | open  |
| Browser tests of the newest screens   | The API is covered; Playwright scenarios for the organisation's appearance, notifications, API keys and webhooks are missing                                                                                                                                                                            | open  |
| Manual accessibility pass             | NVDA and VoiceOver on the interviewer and respondent screens ([`accessibility.md`](accessibility.md))                                                                                                                                                                                                   | open  |
| Backup and restore rehearsal          | Restore an Azure SQL backup into a new database and start the application on it; write the steps in [`operations.md`](operations.md)                                                                                                                                                                    | open  |

## Next: 0.3.0, upkeep

Outcome: the code base stays cheap to change.

- **Maintenance steps, prepared and not yet run**: comments that still describe PostgreSQL, the 16
  `react-hooks/exhaustive-deps` warnings (effects that run on purpose when one value changes; each
  needs a look before dependencies are added) and dead code, in
  [`maintenance-plan.md`](maintenance-plan.md).
- **Dependencies.** Updates wait until they are two weeks old (security fixes excepted). The
  major versions of TypeScript and of any package that has one pending are taken one at a time,
  each with its own commit and the full test run. `follow-redirects` 1.16.2 (an advisory in
  Azurite, a development tool) becomes eligible on 8 November.
- **Deprecation headers** (`Deprecation`, `Sunset`) on the integration API, in place before the
  first deprecation ([`releasing.md`](releasing.md)).

## 1.0.0: what has to be true

Not a date. 1.0.0 is the release after which [the versioning rules](releasing.md) apply as
written, so these must hold first:

- [ ] Every row of [`acceptance.md`](acceptance.md) is proven by a test or a measurement, the load
      rows on the production tier.
- [ ] One organisation has run a real wave on 0.x and its problems are closed or listed.
- [ ] An independent security test (penetration test) of the deployed application, with its findings fixed; the ASVS
      level 2 checklist ([`security.md`](security.md)) reviewed against the final code.
- [ ] The restore of a backup rehearsed and written down.
- [ ] The integration API, the webhooks, the settings and the export layouts described in full in
      the docs, with nothing marked provisional.
- [ ] The WCAG 2.2 AA audit repeated, with the manual screen-reader pass.
- [ ] Each decision still open in an ADR is either built or struck out.

## Later: under consideration

No decision has been taken; each needs an ADR before work starts
([`adr/`](adr/0001-quality-integration-and-channels.md) shows the form). They were left out of
ADR 0001 on purpose.

- **Weighting and calibration** of results (design weights, post-stratification, raking).
- **SCIM** provisioning of users from the organisation's directory.
- **XLSForm import and DDI export** of questionnaires and metadata.

## Decided against

Written down so they are not reopened without new facts.

- **SQLite, or a second SQL dialect, for tests and demos.** The application is T-SQL end to end
  (22 migrations, 36 files with SQL, `OPENJSON`, row-level security with `SESSION_CONTEXT`,
  owner procedures); a second dialect means a second set of migrations and tests that pass where
  production would fail. Development uses a SQL Server in a container or `db:dev`
  ([`dev-database.md`](dev-database.md)); staging and production use Azure SQL.
- **PostgreSQL, also through Babelfish.** Removed on purpose (see the CHANGELOG, 0.1.0); Babelfish
  does not cover the security policies and procedures the isolation depends on.
- **GraphQL for the integration API**, a message-queue service for webhook delivery, signed
  links for audio playback, and recording every interview: the alternatives considered in
  [ADR 0001](adr/0001-quality-integration-and-channels.md) with their reasons.

## How this page is kept

- It is reviewed at every minor release: what shipped leaves (the CHANGELOG has it), the order of
  _Now, Next, Later_ is looked at again, and new items come from the field's problems and from
  the open points above.
- A change to it is a normal commit. An item that needs a real choice gets an ADR first
  ([`adr/`](adr/0001-quality-integration-and-channels.md)); the roadmap links to it.
- An item without a clear outcome does not go in _Now_.
