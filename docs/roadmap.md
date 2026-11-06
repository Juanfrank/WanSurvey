# Roadmap

What is planned and why. It is a statement of intent, not a promise of dates: items are ordered
by how soon we expect to take them (**Now, Next, Later**), and each says the outcome it is for.
What has shipped is in [`CHANGELOG.md`](../CHANGELOG.md); how versions are numbered is in
[`releasing.md`](releasing.md).

**Where we are:** `0.1.0-alpha.19`; every version so far is an alpha. Everything described in the
README is built and tested; what is left is proving it in the field, closing open decisions and
keeping the dependencies current. Leaving alpha (beta, then `0.1.0`) is the first goal below.

## Now: 0.1.0, leaving alpha: ready for real fieldwork

Outcome: the features are complete (`beta`) and, once the items below are closed, `0.1.0`: an
organisation can run its first survey wave on the production deployment and we know, by
measurement, that it holds.

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

## Next: 0.2.0 and after, from the user stories

Source: the first round of user stories with the area (twelve stories, November 2026), contrasted
with `0.1.0-alpha.19`; what each story already had is in the CHANGELOG and the docs, and what is
listed here is what was missing, with the area's own decisions. The order is set with the area; an
item that needs a real design gets an ADR first. Story references (HU-nn) are the area's.

### People registry, history and no contact (HU-02, HU-03, HU-08)

Outcome: nobody is contacted who should not be, by channel, and a person is recognised across
studies and channels.

- **A registry of people for the organisation**, built up over time (like a CRM): who took part in
  what, so that lists arrive already cleaned and duplicates are found by person and not only by
  identifier, phone or e-mail. It extends the cross-case checks that exist today; its design
  (ADR) comes first.
- **An exclusion period per channel**, set as a parameter (and by result), for people who can be
  surveyed through several channels.
- **A no-contact list** per person, per contact (phone, e-mail) or both, for every channel or only
  some, with its permanence as a parameter. People who are "not interested" belong to it.
- **A "do not call / contact" outcome** in the call, which feeds that list.
- **Loading the existing data**: the history since 2020 (an Excel file, the column mapping still to
  define) and the people already marked not interested or not to be contacted.

### Cleaning at load (HU-02)

- **Saved exclusion rules** per project, applied when the list is loaded, with a count of what each
  rule excluded. The criteria come from the area in a spreadsheet; they must be able to carry a
  calendar (to be made precise with the area).
- **Pattern matching in filters and rules**, "as if it were a regular expression", with an engine
  that cannot be made slow by a hostile pattern.
- **Duplicates by the fields the area chooses**, inside a load and against the registry above.
- **Bulk withdrawal**: tick cases, remove them with one reason for all.
- **Normalisation at load**: telephone numbers in international (ISO/E.164) form, names without
  double spaces or stray characters, and the other clean-ups the area lists.

### Where the lists come from (HU-01)

Outcome: populations arrive without anyone loading a file. Pending the area's definition:

- **Zoho**: whether it offers an interface or only files is still to be investigated.
- **The SGC for face-to-face work**: its data are in SQL Server; how the application reads them is
  to be defined.

### The sample (HU-04)

- **Confidence and margin chosen, and kept, with each sample that is added**, not as one setting
  for the project (the area's 95 % and 5 % from January to November and 85 % and 15 % in
  December are met by choosing them for each added sample, so no monthly rule is needed). Today
  a batch takes a number of cases; the confidence and margin behind that number are not kept
  with the batch.
- **Expiry in hours** (the area's 48 hours) instead of days. An expired case leaves the cases
  eligible for contact and nothing more; a new sample is brought in with **Add**.
- **Three ways to change a list**: replace it, add to it, or substitute cases; today there are the
  last two.

### Questionnaires (HU-06)

- **Approval before publishing**: who approves and in how many steps is defined later.
- **Similar questions**: find them to avoid repeating questions, unify the wording across surveys
  and link similar questions to one another.

### Calls and follow-up (HU-08, HU-09, HU-11)

- **A list of early-exit reasons** for interrupted interviews (also on the web and face to face);
  the area gives the list later and generic ones are used meanwhile.
- **Callbacks**: from the calls side panel, a bubble to switch the reminders on, and a button to
  make a callback the next one in the queue. The browser notice is enough for now; e-mail or other
  media come in a later iteration.
- **Reports by difusión, channel and analyst** reuse what exists ("Campañas" became "Difusión").
- **A person identified wrongly in the original record** is handled case by case: mark it, correct
  the result with its history and recalculate the reports.

### The analysis model (HU-12)

The area wants the model readable from SQL by any tool, without anything specific to Power BI.

- **Done in this round**: `docs/bi.md` describes SQL Server and how to create a read-only user;
  the dimensions of the hierarchy were views that a read-only user saw empty, and are tables now
  (migration `0022`).
- **The refresh frequency set in the application's general configuration**, not only by the
  `BI_REFRESH_CRON` setting.

### Waiting for the area

Things the items above need from the area: the exclusion criteria (spreadsheet), the mapping of the
2020 history, the mechanism for Zoho and the SGC, the approval steps, and the list of early-exit
reasons. The other questions of the survey were answered and are recorded above.

## Alongside: upkeep

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

- **A second round of user stories**, for what the first did not cover (quality review, face to
  face, paper, audit, privacy), after this iteration (the area's decision).
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
