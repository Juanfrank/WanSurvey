# Single-tenant mode

WanSurvey serves several organisations (tenants) from one installation by default. An installation
made for one organisation sets **`SINGLE_TENANT=true`** in the deployment's settings (App Service
settings, `apps/api/.env`): what exists only because there may be several organisations is then
hidden in the web app and refused by the API. It is a deployment setting, read when the API and the
worker start: nobody can change it from the interface. Without it (or with `false`) nothing changes.

| Setting             | Value                                                                    |
| ------------------- | ------------------------------------------------------------------------ |
| `SINGLE_TENANT`     | `true` or `false` (default)                                              |
| `SINGLE_TENANT_ORG` | the slug or id of the organisation served, when the database has several |

## Which organisation

The API finds the organisation when it starts (the worker too):

- **None yet** (a new installation): it starts, and serves the first organisation as soon as it
  exists, and keeps serving that one (with `SINGLE_TENANT_ORG`, only once the one it names
  exists). The first is made as always: `INITIAL_ADMIN_USER` (`docs/sso-entra.md`), which only
  ever makes one, on a database with no organisation; or, in development, `pnpm db:seed`, which
  with `SINGLE_TENANT=true` in its environment makes `demo` alone (no `demo2`) and refuses a
  database that already has an organisation.
- **One**: that one.
- **More than one**: it starts and serves **one**; every other is **closed** (below).
  - `SINGLE_TENANT_ORG` names it, by slug (`acme`) or id, in any case. If the database has no
    organisation with that slug or id the start **fails**, since it is a setting to fix:
    `SINGLE_TENANT_ORG=acme, but the database has no organisation with that slug or id; set it to the slug or id of an existing organisation, or leave it unset to serve the oldest`.
  - Without it, the **oldest** (by creation date) is served, and the start log warns:
    `Single-tenant mode: the database has 2 organisations; 1 other is closed (sign-in, sessions, API keys, links and jobs) while the mode is on; their data is kept. SINGLE_TENANT_ORG is not set: serving the oldest, acme (…); set SINGLE_TENANT_ORG to the slug or id of the one to serve`.

If a second organisation is made while the API runs (a script, the seed run without the setting),
the running processes keep serving the first and the second is closed. If organisations appear
after a start on an empty database but none is the one `SINGLE_TENANT_ORG` names, requests answer
**503** `SINGLE_TENANT_ORG` with the same message until it exists or the setting is fixed.

## The other organisations are closed

With the mode on, the organisations other than the one served are **closed**: nothing reaches them
and nothing leaves from them. Their **data is not deleted or changed**: it is only out of reach while
the mode is on (the one exception is a person's opt-out, below). Nothing about it is stored: it is worked out at each start from the settings, so
removing `SINGLE_TENANT` (or pointing `SINGLE_TENANT_ORG` at another one) opens them again at the next
start, with nothing to do by hand. The database is fenced in the API and the worker alike: the
lookups and lists that work across organisations leave the closed ones out, and opening a closed one
in any other way answers as if it did not exist (**404**).

Public answers about a closed organisation are the ones a link or account that never existed gets,
so nothing tells that it is there:

| Door                                                                                           | For a closed organisation                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in with a password                                                                        | an account that is not a member of the served organisation is no account here: "Invalid e-mail or password" (401) whether the password is right or not, without counting failures, locking the account or e-mailing a lock notice |
| Password reset (`/auth/password/forgot`, `/reset`), invitation to join (`/invitations/accept`) | no e-mail for such an account; its reset link and an invitation of a closed organisation are "Invalid or expired link"                                                                                                            |
| Microsoft sign-in (start and callback)                                                         | the start always opens the served one; a callback for a closed one (a sign-in started before) fails as a stale sign-in (`invalid_state`) and records nothing                                                                      |
| Sessions already open                                                                          | 401 `SESSION_EXPIRED`                                                                                                                                                                                                             |
| API keys of the integration (`/ext`, `Authorization: Bearer`)                                  | 401 `INVALID_API_KEY`                                                                                                                                                                                                             |
| Personal web-survey links (`/s/…`), their logo, sync and submit, tracking and unsubscribe      | 404 "Link not found", as an unknown link                                                                                                                                                                                          |
| Open web-survey links (`/o/…`)                                                                 | 404, as an unknown link                                                                                                                                                                                                           |
| Feedback links (`/f/…`)                                                                        | 404, as an unknown link                                                                                                                                                                                                           |
| Share links of the summary (`/share/…`)                                                        | 404 `LINK_EXPIRED`, as an unknown link                                                                                                                                                                                            |
| Mail provider events (`/webhooks/mail`) and SMS replies (`/webhooks/sms`)                      | ignored, except an opt-out: an SMS stop word, a hard bounce or a complaint still puts the address on that organisation's suppression list, so nobody who opted out is written to once it opens again                              |
| E-mail and SMS waves, reminders                                                                | not sent: they wait, untouched, in the database                                                                                                                                                                                   |
| Outgoing webhooks, web notifications (push)                                                    | not delivered: they wait in the outbox                                                                                                                                                                                            |
| Scheduled jobs: case expiry, figures, quality risk, retention and purges, encryption of data   | do not run for them (nothing of theirs is purged or changed)                                                                                                                                                                      |
| Jobs already queued for them (an export, figures to refresh, a scan)                           | set aside without running or failing; the work stays in the database for when they open                                                                                                                                           |

The **analysis model** (`docs/bi.md`) is read straight from the database by its own reader login and
covers every organisation by design; while the others are closed their data does not change, so its
refresh rewrites the same rows for them. Restrict that login in the database if the others' rows must
not be read either.

When the mode is turned off, the waiting mail, webhooks and jobs go out at the next run of the
worker, the links work again and their people sign in as before.

## What is hidden and refused

Refused routes answer **404** with `{ "code": "SINGLE_TENANT" }`: in this installation they do not
exist (as `/health` answers 404 to addresses it does not serve). 403 would say that someone else may
use them, and nobody can.

| Multi-tenant piece                                                                 | With `SINGLE_TENANT=true`                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/auth/tenants` (the person's organisations)                            | 404                                                                                                                                                                |
| `POST /api/v1/auth/switch-tenant`                                                  | 404                                                                                                                                                                |
| `POST /api/v1/auth/login` with `tenant` (slug or id)                               | `tenant` is ignored: the session is always in the one organisation; someone who is not a member of it gets the usual "Invalid e-mail or password"                  |
| `GET /api/v1/auth/me`, login answer: `tenants`                                     | only the one organisation                                                                                                                                          |
| Microsoft sign-in: the organisation found from `?org=` or from the e-mail's domain | always the one; the sign-in page does not ask for the e-mail first (`microsoftNeedsEmail: false`). The organisation's allowed domains still decide who may come in |
| Account menu: the **Organisation** picker                                          | hidden                                                                                                                                                             |
| Waiting page (no role yet): "You also belong to" other organisations               | hidden                                                                                                                                                             |
| Organisation page: the **Whole installation** block                                | hidden; its one setting (the analysis model's refresh) joins the organisation's own cards, since the installation is the organisation                              |

The web app learns the mode from `GET /api/v1/auth/methods` (public, already read by the sign-in
page): `{ "password": …, "microsoftNeedsEmail": …, "singleTenant": true }`; once signed in,
`GET /api/v1/auth/me` carries `singleTenant` too, so the screens that use the session never show a
picker while the mode is still unknown. The web app has no screen
of its own for creating, listing or switching organisations, so there is no route to redirect: the
pieces above are the ones it shows.

## The organisation's logo on the sign-in pages

With several organisations the sign-in page cannot know whose it is, so it shows WanSurvey's logo.
In single-tenant mode it shows the organisation's: `GET /api/v1/public/org-look` (public, 404
`NOT_SINGLE_TENANT` in the other mode) gives only its colours and its logo's address and
description, nothing else (no name or settings), and `GET /api/v1/public/org-look/logo` the
image. The WanSurvey logo is then a **sub-logo** by default ("with WanSurvey", small, under the
organisation's logo and at the foot of the side panel); without a logo the side panel shows the
organisation's name at the top. The organisation can keep WanSurvey as the main logo
(Administration › Organisation › Appearance › WanSurvey logo: Main); in the other mode the default
is Main.

## What stays

What belongs to **the organisation** stays as it is: its name, logo and theme, default language and
time zone, data protection (`ORG_NAME`, `PRIVACY_CONTACT`), roles and their permissions, two-step
verification policy, teams, the registry, API keys, webhooks and the activity log.

Also kept, on purpose:

- **Microsoft sign-in settings** (Organisation page): they are how the one organisation turns
  Microsoft on, lists its e-mail domains and chooses whether a first sign-in creates the account.
  With the deployment's directory (`ENTRA_*`) only those choices are the organisation's.
- **The installation wizard** (`/setup`): it sets up the database, not organisations; an
  installation needs it whatever the mode.
- **Row-level security** by `tenant_id` in the database: it costs nothing with one organisation and
  keeps the isolation if the mode is ever turned off.
- **Accounts are global** (one account, memberships per organisation): with one organisation the
  difference does not show.
- `CONTAINMENT = PARTIAL` (`DATABASE_MANAGE_USERS`) is about SQL Server's contained database users,
  not about organisations: unchanged.
