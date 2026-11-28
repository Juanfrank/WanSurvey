# Single-tenant mode

WanSurvey serves several organisations (tenants) from one installation by default. An installation
made for one organisation sets **`SINGLE_TENANT=true`** in the deployment's settings (App Service
settings, `apps/api/.env`): what exists only because there may be several organisations is then
hidden in the web app and refused by the API. It is a deployment setting, read when the API and the
worker start: nobody can change it from the interface. Without it (or with `false`) nothing changes.

| Setting         | Value                       |
| --------------- | --------------------------- |
| `SINGLE_TENANT` | `true` or `false` (default) |

## Which organisation

The API finds the organisation when it starts (the worker too):

- **None yet** (a new installation): it starts, and serves the first organisation as soon as it
  exists, and keeps serving that one. The first is made as always: `INITIAL_ADMIN_USER`
  (`docs/sso-entra.md`), which only ever makes one, on a database with no organisation; or, in
  development, `pnpm db:seed`, which with `SINGLE_TENANT=true` in its environment makes `demo`
  alone (no `demo2`) and refuses a database that already has an organisation.
- **One**: that one.
- **More than one**: the start **fails** with
  `SINGLE_TENANT=true, but the database has N organisations: the mode serves one; turn it off (SINGLE_TENANT=false) or keep a single organisation in the database`.
  The mode does not pick one: the others would keep running behind its back (their web-survey
  links, e-mail waves, webhooks, share links and jobs do not go through a sign-in), so a database
  of several organisations stays in the default mode.

If a second organisation is made while the API runs (a script, the seed run without the setting),
the running processes keep serving the first and never open the second (its sessions and API keys
are refused); the next start refuses the database. If two appear at once after a start on an empty
database, requests answer **503** `SINGLE_TENANT_AMBIGUOUS` with the same message until it is fixed.

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
| A session or API key of another organisation in the database                       | 401 (`SESSION_EXPIRED`, `INVALID_API_KEY`)                                                                                                                         |
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
