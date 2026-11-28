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

- **Regional format of the organisation**: Administration › Organisation › Regional format
  chooses how dates, times and numbers are written (a BCP 47 locale such as es-PE, es-ES, en-US
  or en-GB: decimal and thousands separators, day before or after the month, 24 or 12 hours),
  with a preview. It applies to every date and number of the app, to dates piped into the
  respondent's form and the paper form's decimal mark, and to readable exports (CSV and Excel
  with labels: moments in the project's time zone, the locale's decimal mark, `;` between the
  fields where that mark is a comma, Excel dates shown the locale's way); files with codes,
  SPSS, Stata and SQL do not change. The interface language stays each person's (dates with
  month names keep its words). By default nothing changes: with no format chosen, dates and
  numbers follow the language as before. The API gives `formatLocale` on `GET /tenant`, takes
  it on `PATCH /tenant` (`tenant.manage`; `null` goes back to the language) and gives it to
  everyone of the organisation in `GET /auth/me` and to respondents with their link.
  **Upgrade**: migration `0034_format_locale.sql` adds `tenants.format_locale` (nullable).
- **Closing a project stops fieldwork and withdraws field access.** Once a project is closed (or
  archived) no interview is started or sent any more, face to face, by telephone or on paper,
  not even by an administrator; cases are neither assigned nor taken; web links show a
  "this survey has closed" page and no invitation or reminder goes out. Interviewers,
  supervisors, reviewers (and customised roles with a fieldwork permission) stop seeing the
  project; whoever runs it, administrators and client viewers keep it for analysis and exports.
  Roles are not deleted: reopening the project gives the access back with cases and assignments
  as they were. The checklist before closing says all this, and how many people lose access and
  how many cases are still on devices. **Upgrade**: migration `0035_project_closed_at.sql` adds
  `projects.closed_at` (projects already closed take the date of their last closing in the
  activity log).
- **Devices clear a closed project.** When a device syncs (on "My device", or when the app is
  opened) and its project is closed, it first
  sends everything waiting, then gives the cases back and removes the project's cases, answers
  and questionnaires from the device. Interviews started before the close are still received
  after it; anything the server no longer takes (started after the close) is never removed: it
  stays on the device and "My device" says so, so the project can be reopened to receive it.
- **Reopening is for whoever runs the project.** "Reopen with N new attempts", reopening an
  expired case and reopening an approved interview (now "Reopen the review") need the project's
  management permission (`projects.update`), in the API and in the interface; supervisors no
  longer see these buttons.
- The designer names the questionnaire once: the breadcrumb ends in its name, edited in place as the page's title, and the toolbar under it keeps only the language, save state, undo, redo and publish. With nothing chosen in the outline the editor says "Choose an item in the outline to edit it."; "Add a section to start." is left for an empty questionnaire. The questionnaire preview has a breadcrumb back to Home, and its scenario-name field no longer cuts its placeholder short on a phone. The feedback links (one per face, the e-mail code, the iframe and the printed QR) add `r=`, `embed=1` and fixed answers to a query the link already has instead of starting a second `?`.
- The option cards of the sampling plan show their description on one line (all of it in the ⓘ), the personal-columns note of an import folds to one line, and a page title keeps its ⓘ close so its buttons fit on the account row.
- **Review queue**: a search by case id (the API's queue takes `q`, part of the case id), and the
  Status filter moves into the Filters panel with the others, with a chip while it is not
  "Waiting for review". A link from Metrics still opens the queue on its interviewer.
- **Tabs on a phone**: the project tabs that do not fit go under "More" on a phone too, instead
  of a row that cut its last tab at the edge (also the administration's section pills).
- **Status messages follow the language**: "Settings saved.", "11 personal links made.", "The
  case is yours now." and the other messages of cases, web survey, analysis, review, calls,
  device and interview are written out when shown, so changing the language changes them too
  (they stayed in the language they were made in).
- Smaller: the auto-provision checkbox of Microsoft sign-in and the two-step count on the
  administration home keep their fine print behind an ⓘ; the dashboard's "Working now" card is
  as tall as its list; the suggested retention periods wrap together.

### Added

- **Single-tenant mode** (`SINGLE_TENANT=true`, a deployment setting; default off, nothing
  changes without it): an installation for one organisation hides and refuses what exists only
  because there may be several. The API answers 404 (`SINGLE_TENANT`) to the list of the person's
  organisations and to switching; sign-in, the Microsoft start and `/auth/me` always use the one
  organisation (the e-mail is no longer asked first to find it). The web app reads the mode from
  `GET /auth/methods` and `GET /auth/me` (`singleTenant`) and leaves out the account menu's
  organisation picker, the waiting page's other organisations and the Organisation page's "Whole
  installation" block (its analysis refresh joins the organisation's cards). A new installation serves its first organisation once it is made
  (`INITIAL_ADMIN_USER`; `db:seed` makes `demo` alone); a database with several organisations
  stops the start, saying so. See [`docs/single-tenant.md`](docs/single-tenant.md). **Upgrade**:
  nothing to do; the new setting is in the App Service templates and `.env.example`.
- **Less scrolling on lists and project pages** (first part): shared building blocks for every
  screen, described in [`docs/ui-patterns.md`](docs/ui-patterns.md): a filter bar (the search in
  view, the other filters in a panel that floats over the list behind a "Filters · N" button,
  chips for the filters that are on), a bar of actions on the ticked rows fixed at the bottom
  while rows are ticked, a side panel for create forms, and a "⋯" menu for secondary actions.
  - **Compact header**: the page title, or on a project the breadcrumb with the project name in
    bold, shares the top row with the account menu instead of taking two rows of its own. The
    project's tabs fit on one line: People and Project settings (and tabs that do not fit) are
    under "More ▾", and the open tab always shows in the row.
  - **Case list**: the figures are a strip of pills (their definition in the tooltip; they
    still filter); Status, Assigned to, Team and the quick filters are behind "Filters"; "⚙
    Rules" and "⋯ More" (names of the sample variables, in a side panel; assign every free case
    by the rules; share out the free cases) sit on the right; assigning, unassigning and
    withdrawing the ticked cases is in a bar at the bottom; each case takes one line; the note on
    hidden personal data is a footnote under the table.
  - **Questionnaire designer**: the breadcrumb, with the questionnaire's name as the title, is
    on the top row beside the account; the name, language, save state, Undo, Redo and Publish
    are one row; Design / Settings, the open one's topics (those that do not fit under "More
    ▾") and a small "Distribution →" link are another, so the editor starts near the top. The
    outline's keyboard shortcuts fold behind "ⓘ Keyboard shortcuts", the routing map's help is
    an ⓘ, a version's "Download JSON" and "Retire" are in its "⋯", and an option's Exclusive,
    Other (specify) and Fixed position are a line of three named toggles instead of three
    stacked checkboxes.
  - **Questionnaires tab**: the modes are one line ("CATI · CAPI · CAWI · PAPI"), the table no
    longer overflows (headers on one line, a questionnaire's successor under its state, the
    actions a "⋯"), and "+ New questionnaire" opens the create form in a side panel instead of
    a form always open under the list.
  - **Preview and printed slips**: the preview's questionnaire and its checks fold into one line
    with the counts, and mode, language, date and full quotas are one slim bar, with "as the
    interviewer sees it" beside the tabs, so the interview starts near the top. The slips page
    puts "← Back" and its title on the top row and its controls in one bar.
  - **Fieldwork screens**: the interview, the review of an interview, My device and the print
    page put their breadcrumb, with the case (or the page) as the title, on the top row beside
    the account; the interview's timers, language and "Saved" are one slim line instead of a
    card, so the question starts near the top. On a paper form, the date and duration written
    on it are one line and the cut-out of a scanned form sits right above its question.
  - **Breadcrumbs keep the page's name whole**: the last step (e.g. "Case HH0031") is not cut
    short any more; the steps before it are cut first, then folded from "Projects" into one "…"
    whose tooltip names them, and the respondent's name beside the case is cut only after that.
    Under 1024 px the interview shows "‹ Case HH0031" (as on a phone), and "Saved on this
    device" stays on the line of the timers. **Print forms** looks like Print slips: "← Back",
    the title and a one-line subtitle on the account's row, "Print" in a bar under it.
  - **Tables that fit**: the case list scrolls sideways with a shade on the edge that has more
    and the case id kept in view; an export's options are one line (the questionnaire and
    "+N", all of them in the tooltip and for screen readers); the Users table fits at 1280 px
    without scrolling; the dashboard's Quotas card explains its target behind an ⓘ.
  - **Calls**: "My callbacks" is folded into a floating "Callbacks (n)" button (amber when some
    are due) that opens the list over the calls; the script and the outcomes get the whole
    width. It can still be kept open as a column. The keyboard keys are a footnote.
  - **My cases** (interviewer): the quality signals and the interviews returned to fix are each
    one compact line. **Home**: the day's figures are pills on the title's line, not tall tiles.
  - **My device**: a slimmer sync bar; "Give back" is in each case's "⋯"; the cases to download
    come 20 at a time ("Show 20 more"). **Scanned forms**: the upload opens in a side panel and
    the batches come first (10 at a time, the forms of a batch 20 at a time).
  - **Review queue**: Status stays in view beside the title; flag, mode, result, interviewer,
    "highest risk first" and "only the random sample" are behind "Filters", with a chip for each
    one that is on. The interviewer pills are one line that scrolls sideways; the queue shows 20
    interviews at a time ("Show 20 more (25 left)"). The coding of "other" answers has its own
    tab under Supervision, with the number of texts still without a code ("“Other” coding ·
    23"); links can open it with `?tab=coding`.
  - **Review of an interview**: the breadcrumb is the page title (the review and the case in
    bold) on the top row; the interview's details and the actions are one slim line, with the
    A/R keys beside the buttons.
  - **Metrics**: the period, mode and team are behind "Filters" with chips; the column names fit
    in two lines and each interviewer in one; the goals come after the table, and the note on
    ▲ ▼ is a footnote.
  - **Results**: the questionnaire, mode, dates, "only where" and "approved only" are behind
    "Filters" with chips, beside the count of interviews; the links for clients open in a side
    panel from "⋯ More".
  - **Exports**: the list comes first; "+ New export" opens the form in a side panel that closes
    on exporting. Each file has a download button with its kind ("⬇ CSV", "⬇ SAV", "⬇ ZIP")
    and a "⋯" menu (export again, copy the download link); the options are short tags (the
    defaults, such as all completes, are left out), and the date it is kept until and the number
    of downloads are one small line.
  - **Project overview**: the goals are in the dashboard's goals card (with "Set goals in the
    project settings" when there are none) instead of a second table at the bottom; the quota
    note is a footnote of the quota table.
  - **Web survey and outreach**: "+ New outreach" opens its form in a side panel instead of a
    form block always open under the outreach. The personal links of an outreach show 20 at a
    time ("Show 20 more"), each on one line; Show, Copy, Change the expiry date (still editable,
    one link at a time) and Revoke are in each link's "⋯". The link builder and the parameters
    for every link wait behind "Link parameters", here and under the open link.
  - **Designer**: the item's comments open in a side panel from "Comments (n)" in the editor's
    header, instead of a block under the editor. Long grey help under a field shows as one line
    with an (i) that unfolds it; short help stays as it was. The project's list of
    questionnaires keeps each one on a line.
  - **Sampling selector**: "Import sample" (and "Add units to the sample") opens the import in
    a wide side panel. The long explanations of the selector are one line with an (i).
  - **Assignment rules**: the workload table keeps each person on a line; "Move someone's
    cases" and "+ Add rule" open their forms on request.
  - **Project settings** (and their web, look, contact, exit reasons and cleaning parts, and
    the paper forms): long explanations are one line with an (i) that unfolds them.
  - **People of the project**: "+ Add a user" (and changing a role) opens a side panel; each
    person takes one line, with Change role and Remove in the row's "⋯"; the introduction is one
    line with an (i).
  - **Administration and users**: each page's introduction is behind an ⓘ beside its title.
    **Users**: search, then Status, Two-step sign-in, Role and Project behind "Filters" with
    chips; "Invite a user" opens a side panel; one line per role (two in view, "+n" for the
    rest) and the row's actions under "⋯". **Activity log**: the quick filters, action, person,
    project, case and dates behind "Filters" with chips, the CSV download beside them, one line
    per entry, and the list grows by 20. **Roles and permissions**: the permissions are grouped
    by area in rows that fold (folded, each role's count in the area; "Unfold every area"), the
    row of role names and the permission names stay in view while the matrix scrolls, and Save
    is above it. **Teams**, **API keys**, **Webhooks** and **People registry**: the create forms
    (and the registry's look-up and file loads) open in side panels; teams and webhooks are dense
    tables, scopes and events short labels, secondary actions under "⋯"; the no-contact list goes
    by pages of 20. **Project people**: adding or changing a role in a side panel, the row's
    actions under "⋯". **Organisation**: the cards pack in two columns and their long help is
    behind ⓘ. The administration overview is more compact.
  - At 200 % zoom (640 px) Users and Roles and permissions no longer scroll the page sideways
    (their tables scroll in their own box); `e2e/hardening.spec.ts` now checks them.
  - **Cases, sampling and project settings (audit fixes)**: when the bar of actions on the
    ticked cases comes up over the end of the list, the page moves up so the pagination shows
    above it, and its person picker is no longer cut short. The case list's headings stay on one
    line ("Assigned for", with "Time since assignment" in its title) and a finished case's review reads
    "Complete · approved" (the word "Review" in its title and for screen readers). With more
    than three questionnaires, the cases' questionnaire picker is a drop-down list instead of
    pills that wrap. The sample import's column mapping fits the side panel (the type under the
    field name). In Assignment rules, the workload's person column stays in view while the
    figures scroll, with their teams under the name. Project settings lay out their blocks in two
    independent columns (no gaps beside a taller block), and "Exclude people under this age"
    sits beside its box. **Goals**: the explanation is behind an ⓘ, each goal is one line (the
    progress as "0/20" with a bar; the current window and the count due by today in its title),
    the questionnaire column shows only when a goal counts a single questionnaire, and Remove is
    a ✕. A centred dialog's buttons (`Dialog`'s `footer`) stay at its bottom while the body
    scrolls: the user's roles dialog uses it, so Cancel and Save roles are always in view.
  - **Designer and preview (second audit)**: with the outline pinned, the breadcrumb and the
    toolbar (name, save state, undo, redo, Publish) span the page's whole width above the
    outline and the editor, as on Settings: the outline is a sticky column under them instead of
    a pane over the whole height. A long questionnaire name ends in "…" (whole on pointing);
    short of room, the breadcrumb's earlier steps fold to "…" before its last one, and the save
    state becomes a sign that keeps its words as its name. "Save to library…" moved to the
    item's "⋯" menu, so the editor's header shows the question type and code in full. In the
    preview below 768 px, the questionnaire line and the mode, language, date, quotas, JSON and
    restart controls fold behind "Set up the test ▸" (with the mode, language and checks in the
    line), so the question is on the first screen; the phone frame is as tall as its content.
  - **Create forms in side panels and long lists in blocks (third audit)**: "+ New project"
    beside the page title opens the new project's form (name, code, modes) in a side panel with
    Cancel and Create project at its foot, instead of a block above the list. In Settings →
    Goals, "+ Add goal" beside the title opens the goal's form in a side panel. The assignment
    rules open in a side panel instead of a centred dialog, and "+ Add rule" opens the rule's form
    in a second panel over it (Escape closes that form only). The case list, My cases and the
    pool come in blocks of 20 with "Show 20 more (N left)" under them (the server's pages of 20,
    added one under the other) instead of pages of 25; the count under the list reads "20 of 31
    cases", ticking and the bar of ticked cases work across the blocks shown, and a new filter
    starts again from the first block. In the questionnaires table, a closed questionnaire's state keeps
    one line and "→ continues in …" a second one, cut with "…" (whole in its title). Settings → Project status
    and the logo description of Logo and style keep their help to one line behind an ⓘ that
    unfolds it.

- **Case list for field supervision**: quick filters "Due within 48 h", "Overdue" (by the case
  deadline) and "Not tried yet", a team filter, the review state of finished cases, and the
  workload table with overdue cases, callbacks due, today's completes and last contact. An
  interviewer's "Start"/"Continue" opens the interview from the list, their weekly goal shows
  beside their figures, and on a phone each case is a card. The case panel keeps its code, status
  and main actions in view; a case closed after its last call attempt shows the attempts against
  the limit and can be reopened with a new round (`POST /projects/:id/cases/:caseId/reopen-attempts`,
  recorded in its history and the audit log).
- **Supervision shortcuts and filters**: in Metrics, an interviewer's name opens the review queue
  on their interviews (`?tab=review&interviewer=…`; the queue also takes `?result=`), the project
  page follows such links without a reload, a team filter ranks one crew or shift at a time
  (`teamId` on `GET /projects/:id/metrics/interviewers`, which now lists the teams), and "Project
  settings → Goals" is a link. The review screen has a full breadcrumb (Projects / project /
  Supervision / case).
- **Crosstab in Excel** next to the CSV download, with the same cells and filters; a CSV export
  can carry its codebook (variables and values as CSV) in a ZIP (`codebook: true`).
- **Home portfolio**: fieldwork dates and the last interview activity of each project.
- **Retention on the project overview**: the personal data period and what happens when it ends,
  or a warning when there is none, with tonight's count for who configures the project.
- **Interview, calls and devices (expert panel, second round)**: on a phone's touch screen, Back
  and Next stay at the bottom under the thumb, for interviewers and web respondents; the interview
  screen has a breadcrumb (Projects / project / My cases / case); the card shown when an interview
  is taken up again repeats the interviewer's last note; the end message names the disposition
  ("refusal") instead of its code. The Phone calls workspace shows the caller's goal and pace and,
  while no case is open, what "Next case" would bring (a read-only preview, `GET
/projects/:id/cati/peek`). The live dashboard lists, for supervisors, the cases each interviewer
  holds on a device and when it last synchronised (`GET /projects/:id/capi/devices`). The date
  and duration written on a paper form are checked on the server too (`PAPER_META_INVALID`).
  **Upgrade**: migration `0031_device_syncs.sql` adds the `device_syncs` table.
- **Administration, users and activity log**: "See their activity" in each user's actions opens
  the activity log on that person; Users filters by two-step sign-in, and the counts of the
  administration overview open Users with their filter on; the account menu offers to turn on
  two-step verification to whoever has not; administrators see the webhooks and their deliveries,
  read only; inviting or changing the roles of someone of the client organisation asks a reason
  on Users too, as on the project's people page; share-outs and lists of cases handed to someone
  record whose cases they were; the roles dialog has short labels with the role's description
  under the row; an unknown address shows a translated page with a link home. **Upgrade**:
  migration `0032` adds indexed columns to the activity log for its project and case filters.

- **Personal web links expire and can be revoked** (migration `0033_cawi_link_expiry`): an
  outreach can give its links an end date, each link can get its own, and "Revoke" withdraws one
  (both logged). An expired or revoked link tells the respondent so and is no longer sent or
  reminded of. The designer's checks, the editor and the API also gained: options and grid rows
  without a label marked beside their field, the selected item's checks listed above its fields,
  a quota target above its maximum refused, personal data shown or asked before the information
  notice warned about, and a web survey style with unreadable colours refused by the API too
  (`THEME_CONTRAST`). The questionnaire's Distribution tab became a link to the project's one; the
  item inspector's parts are a segmented control; the routing map says "skips to the end of the
  questionnaire"; the mode comparison preview uses the preview's seed.
- **Rotation and randomisation of a section's or block's items**: in the editor, "Order of the
  items" shuffles or rotates them per interview (seeded by the interview, so every device and the
  server see the same order); items can be kept in place in the definition (`itemOrder.fixed`), and an optional
  variable records the order shown and is exported with the data. "Check the logic" reports items
  that read, or skip into, a sibling whose place changes.
- **Method warnings in "Check the logic"**: a case or respondent insertion with no fallback text
  (`| default:"…"`), a shuffled ordered scale, "Don't know" offered for a consent or a contact
  detail, a sensitive required question web respondents cannot decline, a grid of more than 7
  rows, an "Other" option that does not ask to specify, and a Yes/No question that asks two things.

- **Sampling selector: a step index and the checks always in view.** A bar fixed at the top links to
  the four layers and says how many problems block the selection and how many warnings there are. The
  plan now warns when the expected response is above 80 % or there are no reserves (except in a census).
  The (i) help buttons are 24 px targets, and their bubble closes with Escape and stays open under the
  pointer.
- **Importing cases suggests more personal columns**: dates of birth, document and tax numbers and
  postcodes, besides names and contacts; the mapping step explains what "Personal" does and that exact
  age, city or region can also identify someone.
- **Sharing out at random starts with the interviewers only**: owners and administrators (who may hold
  cases) are listed apart under "Other roles", with their role, and not chosen unless ticked. A **team**
  of the organisation can be chosen as the people to share among; each person who can work cases now
  carries their teams (`GET /projects/:id/assignees`), also shown in the workload.
- **Moving someone's cases** (when they fall ill or leave): the workload in the assignment rules moves
  every case a person holds and has not started to another person in one step
  (`POST /projects/:id/cases/assign` with `fromUserId`); interviews already started stay with them.
- **Calls workspace (CATI) clearer and quicker**: outcomes grouped (reached, not reached, call again,
  closes the case) with 0 as the key of the tenth, "Do not contact again"; the callback time confirmed
  in words ("Thursday 26 November, 20:24, respondent's time (in 1 hour)"); unset calling hours read as
  "no restriction" instead of "00:00–00:00"; a separate 44 px "Call" button beside each number, with
  common labels translated; case data above the outcomes, with the sample fields' labels; the save
  button says what is missing; and, with no case open, the caller's day so far (calls, contacts,
  completes, time on the phone; `GET /projects/:id/cati/shift`).
- **Questionnaire designer, after the expert panel**: one toolbar on every tab (name, then language,
  save state, undo, redo and publish as one group), kept at the top while scrolling; the outline's add
  buttons wrap instead of being cut. The Logic tab no longer says "Always (no condition)" twice, folds the
  option filter, case data and link parameter into "Add …" buttons until used, and warns in plain view
  that answers to skipped items are deleted. Under Don't know / Refused the editor says in which of the
  questionnaire's modes they are really offered, and Settings › Special answers chooses those modes
  (CATI, CAPI, PAPI). The red → amber → green scale palette is marked for service ratings, with a
  warning about mode effects and colour blindness. While translating, the default language's text and
  option labels are shown read-only beside each field. The library refuses an item with errors or
  unlabelled options. A new questionnaire starts with no mode ticked (unless the project has one), and
  ticking several warns that it is a mixed-mode design.
- **Administration: an overview, blocks and a two-step policy.** `/admin` now opens on an overview of
  what needs attention (people waiting for a role, invitations not accepted, people who must use two-step
  verification and have not, API keys ending within 15 days) and the sections in three blocks (People and
  access, Organisation, Security and integrations), as the side menu now lists them. Organisation gains
  **Sign-in security**: besides owners and administrators, which roles must turn on two-step
  verification (asked at their next sign-in). The analysis-model refresh moves under a **Whole
  installation** heading. Project managers and supervisors no longer see Users and Teams in the menu
  (the pages stay open to them, read only). Roles and permissions marks sensitive permissions, counts
  unsaved changes and confirms what is given and taken away, and to how many people, before saving; the
  matrix cells are bigger targets. Administrators see the API keys read only; revoking one asks in a
  dialog. The installation wizard has short labels with help underneath and says plainly that the schema
  is final.
- **The activity log reads in words and answers data questions**: each action has a name in Spanish and
  English (the code stays beside it); "View details" opens each entry's details as lines (a role change as
  the permissions added and removed, other changes as before → after), with the full record as JSON below;
  quick filters for data corrections, review decisions, exports and downloads, views of personal data, case
  assignment, roles, deletions and sign-ins; filters by project and by case (its code or id); pages of 50
  with no cap (the API takes `beforeAt`/`beforeId`, `actions`, `projectId` and `caseRef`), and the export
  takes the same filters. Corrections and review decisions now record their project and case; earlier ones
  are found by the other filters but not by project or case.
- **Users page: open cases, filters and a safer deactivation.** A column shows each user's open cases
  and how many are on a device; the list filters by role and project; a user waiting for a role has an
  "Assign a role" button. Deactivating opens a dialog that lists their open cases per project (with
  those on a device and since when) and links to each project's cases; the message after it offers to
  reactivate, and the roles of a deactivated user show as without effect. The roles editor warns when a
  row adds nothing that another row already gives, and links to Roles and permissions. The invitation
  opens in a dialog, removing someone from a project asks in a dialog instead of the browser's, and the
  staff are called "users" on the Users page and in the project's list of users (not "people", which
  the registry of respondents uses).
- **Home by role**: administrators see who is waiting for a role, invitations not accepted and active
  people without two-step verification; project managers, supervisors and clients see each project's
  completes against the target, team pace, unassigned cases, callbacks due, interviews to review (with
  those flagged too fast) and who is working now; interviewers see their day: interviews returned to
  them, callbacks due with a button to call each one, cases to do and their goal for today. The
  questionnaire preview is a secondary link, for those who design questionnaires. New `GET /home`.

- **My device shows the sync state at a glance**: a status card (connection, interviews to send as a
  large number, last sync, a warning after 24 hours without syncing, why "Sync now" is unavailable
  offline), the deadline and priority of each downloaded case, and a personal-data notice. Beside the
  project title, "My device" is a plain link with a separate indicator ("Online · 0 to send · 3 cases on
  this device"). Signing out says what stays on the device: unsent interviews are kept (never removed),
  and downloaded cases can be given back and removed.
- **Privacy of project people, web links and retention**: giving someone of the client organisation a
  project role that opens interviews, recordings or personal data shows what they will see and asks why
  (the project people endpoint requires `reason`, kept in the activity log); personal web links are cut
  short on screen, shown or copied one at a time, and opening the list and downloading it are logged
  (`cawi.links_viewed`, `cawi.links_downloaded`); the retention setting offers 90/180/365 days and says how
  many cases the next nightly run would anonymise; the help of "show interviewers personal data" says what
  turning it off masks (tablets, telephone console); a confidentiality reminder next to shown case data and
  the calling console's sample; the Organisation page says who answers for the data and where it is kept; the
  respondent's "Privacy policy" footer follows the survey's language.
- **Web survey accessibility**: the project logo can carry a description that screen readers read
  (Logo and style); e-mail and phone questions let the respondent's browser fill them in (only on
  the web survey); a page that opens with a text starts there, not at the first answer; the
  privacy footer speaks the survey's language; Logo and style refuses to save while any shade made
  from the main colour is unreadable (the API does not check it yet); respondents no longer see a
  focus box around a text item; phones show no keyboard hints and the buttons wrap instead of
  overflowing. `docs/accessibility.md` has a manual plan for
  NVDA, VoiceOver and 200 % zoom.

- **Interviewer screen easier to read and to take up again**: sample data and answers show readable
  names with the code in small print (a coded sample column shows its question's label, e.g. "South (2)");
  prefilled answers not yet asked are listed apart as sample data to confirm; the section is marked current
  on its opening text too; don't know and refused carry "Do not read"; one end card with a summary, submit
  and going back; a card on resuming says where the interview stopped and how long ago. On tablets and
  phones the case details start hidden and the actions stay at the bottom of the screen. The demo household
  survey no longer tells the interviewer to record sex without asking.
- **Review by interviewer, by result, and double entry as one item**: the review queue counts each
  interviewer's interviews and those with quality flags (click to see only theirs), filters by result
  (complete, screened out, refusal…), and shows a paper form keyed twice once, as its first entry with
  the differences still open; that entry cannot be approved until they are resolved (`ENTRIES_DIFFER`).
  The review screen marks questions with confirmed warnings and can show only the questions with
  warnings, notes, comments or changes. "Returned to me" lists the commented questions, the interview
  offers "Go to" each one, and interviewers see their own quality signals (approved, returned, rejected,
  flags, median length beside the team's; `GET /projects/:id/review/mine`).
- **The case list's figures match the dashboard and explain themselves**: one card per state (New,
  Assigned, In progress, Finalised, Withdrawn) with a one-line definition, adding up to the total shown
  beside them; a click filters the list. Interviewers instead see their own work (to do, callbacks and
  appointments due, returned to them, finalised) and their list is ordered by what to do first, with a
  Start or Continue button per row, the final result of finalised cases and their callback time.
  "Time since assignment" is no longer shown for closed cases, hidden personal values show a padlock and the word
  "hidden", sample variables can be given readable names, the case detail separates its sections and
  shows the withdraw and misidentified actions in red, and interviewers are no longer offered draft
  questionnaires.
- **Project life cycle, fieldwork plan, pace and risks**: Settings → Project status moves a project
  between draft, active, closed and archived (each change in the audit log) and lists what is still
  open before closing it: open cases, interviews to submit or review, the final export, client links
  and people with access. Settings → Fieldwork takes the planned start and end of fieldwork; the
  dashboard then shows the completes due by today, those needed per day (also as a line over
  completes per day), the current pace and the estimated end. Quota cells take an optional target
  besides their maximum, and the dashboard shows target, %, missing and state (behind, nearly full,
  full…), riskiest first. Supervisors and project managers also see the goals' state and a Risks card
  (interviewers with repeated quality flags awaiting review, quota cells behind the pace, cases
  reaching their deadline within 48 hours).
- **Analysis, metrics and exports reviewed**:
  - Results and the summary warn when the figures include interviews not approved yet, with a button
    to keep approved interviews only. A client link can be fixed to approved interviews (migration
    `0030`), and the summary adds a fieldwork progress section (cases, final outcomes, quotas, days).
  - The topline groups open answers written alike, marks computed variables and counts don't know /
    refused and missing values for numbers.
  - The crosstab offers column, row or total percentages, its base, flags bases under 30, adds a
    chi-square test and downloads as CSV.
  - Wide tables scroll from the keyboard and show a shade while columns are hidden (`TableScroll`).
    Metric outliers say in words what they mean and whether they call for a review.
  - The list of exports shows each export's options, how long its file stays available and who
    downloaded it, with an "Export again" button. Personal answers can be left out, and the app leaves
    them out by default.

- **Project navigation** (expert panel): an **Overview** tab (live progress, quotas and goals) where a
  manager lands once a questionnaire is out; a **Distribution** tab with the web surveys and paper forms
  of every questionnaire, out of the questionnaire editor (`?tab=web|paper&q=` land there); the review
  queue and the interviewers' metrics together under **Supervision** (Results keeps the summary);
  **Project settings** with its topics in groups down the side (Operation, Modes, Brand and privacy),
  "Fieldwork" renamed **Goals** and the questionnaire's tab called "Ajustes del cuestionario" in Spanish;
  an open case in the address (`?case=`); a three-level breadcrumb on the project and device pages;
  "My device" first beside the tabs. Interviewers and clerks no longer get the Questionnaires tab (paper
  forms are their own tab) and their case filter lists only published questionnaires.
- **Double entry with context**: each difference shows which clerk keyed each value; when both are
  wrong the supervisor types the value read on the form (checked like a reviewer's correction), with an
  optional reason kept in the audit log
  (`choice: "other"`); and a summary gives the forms compared, the share without differences, the values
  not kept per clerk and the questions with most differences (`GET papi/agreement`). The paper form's
  date and duration are checked (not after today; 1 to 600 whole minutes), and the second round of a
  scanned form says which of the questions left it is on. Printed forms name the outcome ("rechazo",
  not `REFUSAL`) and say "pase al final"; the routing map reads "salta a la siguiente fila del roster".
  The upload message of scanned forms follows the interface language.
- **The environment-variable templates say what is required**: each `<…>` placeholder starts with
  `REQUIRED`, `OPTIONAL` or `CONDITIONAL` and, for the last, says when it is required. A placeholder left
  as it is counts as not set when it is optional or conditional, and stops the application, naming it, when
  it is required.
- **Error reporting to Azure Application Insights** (`APPLICATIONINSIGHTS_CONNECTION_STRING`, replacing
  the `SENTRY_DSN` that never did anything): an error nobody handled, a request that ended in 5xx and a job
  that failed for good are sent to Application Insights, with e-mail addresses, numbers, passwords,
  tokens, query strings and database-quoted values removed first, and no bodies, headers, cookies or
  client addresses. At most 30 exceptions a minute; off when the setting is empty. The privacy policy and
  About say so when it is on. See `docs/operations.md`.
- **The generated SQL scripts are divided in commented sections**: a heading for each kind of object
  (tables, foreign keys, indexes, functions and views, procedures, triggers, row-level security, initial
  data, permissions) and a comment before each one, so each table's creation can be found and read apart.
- **The installation scripts no longer carry the migrations.** A new installation takes a **baseline**
  (`apps/api/mssql/baseline.sql`, regenerated at each release with `db:baseline`): the structure the
  migrations leave, as plain `CREATE` statements. The wizard and `db:script` give (1) the structure, (2)
  the users and permissions, and (3) a separate migrations script **only if** some migration is newer than
  the baseline (none today). The application's own migration also takes the baseline on a new database. A
  test compares a database made from the baseline with one made by replaying the migrations.
- **Accessibility checks for dialogs and side panels**: every dialog that opens in a browser test is
  checked with axe while open (an automatic fixture), the dialogs no other flow opens and the
  side panels and menus in each state have tests of their own (`docs/accessibility.md`).
- **About, Privacy and Terms follow the institution's common schema** (`docs/info-pages.md`): shared
  types in `@wansurvey/schema`; About in a fixed order (`what`, `who`, `version`, `rights` if there is an
  author or holder, `access`, `contact`, `documents`, and `technical` for people with a session); only
  the services that are on are claimed; no changelog or accessibility claim in the public text; a
  language selector and a Back link; inside the application's frame for people who work in it. New
  `GET /api/v1/system/technical` (session only) and the setting `APP_BUILD`.
- **Author and holder on the About page**: an "Authorship and ownership" section, separate from the
  organisation that runs the installation. The author (Juan Francisco Medina) is fixed in the project, with no setting; `APP_HOLDER` (optional) adds the holder of the rights.
- **The installation wizard follows the installation through its steps.** Besides running without
  `DATABASE_URL`, it now runs when `DATABASE_URL` is set but the database is not ready (and there is no
  `DATABASE_ADMIN_URL`): it shows which step is pending (server, sign-in of the application's user,
  tables and permissions), checks again by itself, and starts the application without a restart when
  everything is ready. With `DATABASE_ADMIN_URL`, if the migrations fail at start (server unreachable,
  owner refused, a failed migration) the wizard runs and retries them every 10 seconds instead of the
  process stopping. The worker waits for the installation instead of failing.
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

- **Behaviour change — exports leave personal data out unless asked for.** `POST
/projects/:id/exports` (data files of every format and the codebook) now defaults to
  `personalData: "exclude"`, as the app already did. Answers marked personal go into the file
  only with `personalData: "include"`, and only for someone with the permission to see personal
  data (`pii.view`) in the project; without it the request is refused with `403
PERSONAL_DATA_FORBIDDEN` instead of being quietly answered with less than it asked for. The
  integration API takes the same parameter on `GET /ext/v1/projects/:id/cases`: `exclude` (the
  default) is accepted and `include` answers `403 PERSONAL_DATA_FORBIDDEN`, since no key holds
  the permission (personal sample fields stay masked). Webhooks carry identifiers and statuses
  only, as before. **Upgrade**: a script or integration that relied on the old default must send
  `"personalData": "include"` (as a person with `pii.view`) to keep personal answers in its
  files. Documented in [`docs/integration-api.md`](docs/integration-api.md) and the OpenAPI body.
- **Behaviour change — two-step verification for every password sign-in.** Every account that
  signs in with a password must use two-step verification (an authenticator app): whoever has
  not set it up is asked to at the next sign-in, before anything else, whatever the role.
  Signing in with Microsoft never asks for it (the directory applies its own MFA), owners
  included; someone who set up the code still enters it when Microsoft does not report MFA.
  The per-role policy of the Organisation page is gone, since every role is covered: the card
  now says the rule and how many people still have to set it up, and a `PATCH /tenant` with
  `settings.twoFactorRoles` is refused (a stored list is ignored). The administration home's
  count and the Users filter "Must set it up (signs in with a password)" count active people
  who may sign in with a password and have no authenticator app (the people list gives
  `twoStepRequired` and `hasPassword`; `GET /auth/methods` gives `passwordTwoStep`). New
  setting `PASSWORD_2FA_REQUIRED` (default `true`): `false` asks it only of owners and
  administrators, for local demos and the end-to-end and API tests, and is refused when
  `NODE_ENV=production`. **Upgrade**: people without an authenticator app who sign in with a
  password are asked to set one up at their next sign-in; tell them before deploying.
- **Behaviour change — interviews carry only the personal data the questionnaire uses.** The
  interviewer's screen (CATI, CAPI and paper entry) no longer lists the case's personal data
  ("Show case details" keeps the sections, the sample fields that are not personal and the
  answers): a personal field reaches the interview only where the questionnaire uses it, in a
  text, an introduction, a script, a prefill or a condition (`¿Hablo con
{{case.first_name}}?`; `{{respondent.firstName}}` needs the first-name field), worked out
  from the questionnaire version's references. The API sends nothing else personal to the
  interview, nor to the device's offline copy: unused personal fields are left out (not
  masked) and contacts no longer travel with the interview; an interview started before this
  is sent minimised as well.
  - **Telephone**: the calls screen shows a case's numbers by their last digits ("••4321"); the
    Call button's `tel:` link hands the whole number to the phone, and the case's personal
    fields show only in the scripts that pipe them.
  - **Face to face**: Project settings → Modes → Face to face has "Needed to reach the household": the
    personal sample fields (the address, a reference) and the case's addresses ticked there
    are shown apart, under "To reach the household", in face-to-face interviews and kept in the
    tablet's copy, even where the questionnaire does not show them. Nothing is ticked by
    default: an address reaches the tablet only if the project marks it.

- **Long help behind an ⓘ on cases, web links, scans and the device** (fourth visual audit):
  - A case's personal data says "Confidential data · your view is recorded" on one line; why
    they show and how to treat them are behind its ⓘ, said once (also on the calls screen).
  - Personal links: "Treat these links like passwords." on one line with an ⓘ; the link
    builder's explanation is an ⓘ beside its title and its empty state is one line. The SMS
    and links-only channels of a new wave have a one-line hint and the rest behind an ⓘ.
  - "Upload scans" opens with "Upload one or more scanned PDFs." and an ⓘ for the rest.
  - The sample selector: adding units after the selection, the census size and the three
    sizes are an ⓘ or one folded line (the three sizes were said twice), and the bar of steps
    keeps to one row on a laptop.
  - Smaller: the sample variable names, "Share out at random", the device's personal-data
    note and its download help, and the "no retention period" warning take one line each.
- **Users, administration, the designer's skips and the phone's interview bar** (fourth visual
  audit, J2):
  - Users: in the roles editor, "Add one row per role…" is behind an (i) beside "Roles"; in the
    invitation, "They receive an e-mail… (valid 7 days)…" is one line cut short with an (i). When
    a client's new role asks why (in Users or a project's People), the warning and its "Why do
    they need it?" field scroll into view instead of staying under the dialog's footer.
  - Administration on narrow screens (and at 200 % zoom): the section pills keep one line, as a
    project's tabs; those that do not fit go under "More ▾" and the open one always shows. The
    measuring of `OverflowTabList` is shared as `useOverflowFit` (`routes/tabs.tsx`).
  - Designer › Logic: that skipped answers are cleared is behind the (i) of "Skips", not an amber
    box under it.
  - Interview on a phone or a tablet: the bar of actions has an opaque background with a line
    above it from one side of the screen to the other, light or dark, so nothing shows through.
  - A filter's chip is cut short at 18 rem (whole in its title), so the count keeps its line.
  - Audit log: with nothing to show, the table says so in a row ("No entries match. Remove a
    filter…").

- **Fewer fixed paragraphs, a one-line interview bar on phones** (third visual audit, H2):
  - Webhooks, API keys and Teams: whoever may only look sees a compact "Read only" badge in the
    page header; who changes them is behind its (i), not in a paragraph under the title.
  - The designer's Languages › Translations, the feedback form's designer (what the form is
    for, what a link parameter does) and its links ("Each face has its own link…") keep their
    explanations behind an (i) beside the heading or label.
  - The interview's bar of actions keeps one line under 640 px: Note, Pause and "⋯" with the
    case details and "Suspend and leave"; "Keyboard shortcuts" is not offered on a phone or a
    touch screen. Tablets and desktops keep every button in view.

- **Less crowding on Home, analysis, review and administration** (at 1280 px):
  - Home: the project's name and its code keep to one line each, cut with "…"; the headers
    "Team pace", "Callbacks due" and "Working now" are written short (the full name is the title
    and what a screen reader reads); the fieldwork dates and the last activity fold under each
    project behind a "▸" ("More on …").
  - Roles and permissions: the role names in the header are short ("Manager", "Client"), the full
    name in the title and for screen readers, so every column, Client included, is in view.
  - Audit log: the Details column takes the width that is left and its summary is cut with "…"
    inside the cell; the table no longer runs past the card, open entries included.
  - Review queue: the permanent "By interviewer" row of pills is gone; the Interviewer filter in
    the Filters panel lists each person with their interviews and flags, and the chip shows who is
    chosen.
  - Results: below 1536 px the crosstab takes the full width above the questions (beside them on
    wider screens), and each cell keeps "% [n]" on one line.
  - Metrics: what ▲ and ▼ mean is behind an ⓘ beside the title instead of a paragraph under the
    table.
  - Overview: the pace figures are in two columns, so their labels fit in at most two lines.
- **Interviewer screens, less crowded**: on a project, "My device" and the connection state
  ("Online · 0 to send") sit at the right end of the tabs' row (a row of their own on a phone)
  instead of beside the project's name, so the breadcrumb keeps one line; a long project name is
  cut short with "…" (whole on hover). In Phone calls, the "Callbacks" button sits at the end of
  the title row instead of floating over the call's outcomes; its list opens below it. In My
  cases, "My quality signals" is folded ("My quality signals ▸") at the end of the counts' title,
  so the list moves up; opened, the figures are one column on a phone. An interview on a phone
  shows only "‹ Case HH0031" at the top (‹ goes back) and one line of details (respondent,
  interview time, saved state), so the question shows sooner.
- **One place for the results summary**: the printable summary (PDF) opens from Results only; the
  duplicate button in Exports is gone (the client links were already only in Results).
- **«Completar» is now «Cerrar trabajo de campo» (Close fieldwork)** in a questionnaire's actions, its
  dialog, its state and its banner: the action closes data collection, it does not finish the design.
- **The account menu has a row of its own** at the top of every page, instead of floating over the
  page's first line: it no longer covers the interview timer, the CATI header or the review's case
  header. A disabled main button is now grey rather than a faded blue, so it no longer looks like one
  more kind of button. In the dark theme the side panel darkens with the page.
- **A collapsed side pane (callbacks, outline) opens when the pointer rests on its rail** for a moment,
  and then stays open until Escape, its close button or a click elsewhere, instead of closing as soon as
  the pointer drifts off it; on touch screens it opens with a tap only. A screen reader reads the
  callbacks count with the rail button ("My callbacks, Due now: 1").
- **The generated SQL scripts, and the ones in `infra/sql/`, are plain T-SQL**: one batch with no `GO`, no
  `:on error exit` and no `sqlcmd` variables, so they run in SSMS, Azure Data Studio or the portal as in
  `sqlcmd`. Passwords and names are written in `DECLARE` lines at the top (the file refuses to run with a
  placeholder left); each object goes through `EXEC`, inside `TRY/CATCH` with one transaction.
- **The installation wizard asks for the server and the port in one field** (`host` or `host:1434`):
  leave the port out when it is the default.
- **Everything is in the one schema** (`DATABASE_SCHEMA`; `dbo` by default). The analysis model is no
  longer in a schema `bi`: its tables, views, procedures and functions are `<schema>.bi_*` (for example
  `bi_dim_proyecto`, `bi_plano_respuestas`, `bi_refrescar`), and the row-level security objects are
  `<schema>.rls_*`. No schema other than the application's is made. **Upgrade:** a database made with
  an earlier alpha (schemas `bi` and `rls`) must be made again; there is no migration of the old
  layout. The read-only user now has `SELECT` on each `bi_` table and view (object by object, instead
  of on a schema), `DENY` on every other table and view, and no write, `EXECUTE` or `ALTER` on the
  schema. The SQL export names the model's objects with the schema (`[dbo].bi_fact_envio`).
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

- **Publishing with a mapping**: just after choosing what happens to a variable's old answers,
  the dialog still showed the last check's "Choose what happens to A_WORK" until the server
  checked again. Problems of an older choice are now hidden, and "Publish" waits, until that
  check answers.
- **The side panel follows the window until a choice is saved**: a window that grew from a
  phone's width to a laptop's kept the compact panel of the phone, which then opened over the
  page under the pointer (the paper preview's title, mode and tabs were hidden behind it). With
  nothing chosen it now takes the default of the current width.
- **Feedback links**: the HTML copied for an e-mail carried React's `className` attribute; it is
  now a plain table, with its labels (and the web page embed's name) escaped.
- **The waiting page speaks the interface's language**: "Your account is active, but no role has
  been assigned…" was always in English; it is now translated (Spanish too), with the
  organisation's name.
- `approvedOnly=false` in the address of the topline, crosstab and summary was read as true.
- **New projects take the organisation's time zone and language** (Administration > Organisation): the
  new-project form showed and sent the browser's zone (often UTC) and always Spanish.
- **A callback's date and time are written out in full** below the picker (in the interface language and
  the respondent's zone): the browser's own picker follows the browser's locale (11/26/2026, 08:24 PM),
  not the interface's.
- The tables of the API keys and of the webhook deliveries had a column header with no text (the
  actions column): it now has one for screen readers.
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
