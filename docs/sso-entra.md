# Microsoft sign-in (Entra ID / Azure AD)

Each WanSurvey organisation can let its staff sign in with their Microsoft work accounts. The organisation connects **its own** Entra tenant, so every agency controls its own directory, Conditional Access and MFA.

## 1. Register an app in Microsoft Entra

In the Microsoft Entra admin center, go to **App registrations → New registration**:

| Setting                 | Value                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Name                    | `WanSurvey`                                                                                                                                                              |
| Supported account types | _Accounts in this organizational directory only_ (single tenant)                                                                                                         |
| Redirect URI            | Platform **Web**, set to the `redirectUri` shown by `GET /api/v1/tenant/sso`, for example `https://encuestas.example.org/api/auth/entra/callback` (`ENTRA_REDIRECT_URI`) |

Then, in the new app registration:

- **Certificates & secrets → New client secret.** Copy the secret's **Value**; Microsoft only shows it once.
- **Token configuration → Add optional claim → ID → `email`.** WanSurvey falls back to `preferred_username` (the UPN) when `email` is missing.
- **API permissions:** the default delegated `openid`, `profile` and `email` permissions are enough. No admin consent beyond that is needed.

From **Overview**, note the **Directory (tenant) ID** and the **Application (client) ID**.

## 2. Connect it in WanSurvey

An owner or admin (permission `tenant.manage`) saves the settings:

```http
PUT /api/v1/tenant/sso
{
  "entraTenantId": "<Directory (tenant) ID>",
  "clientId": "<Application (client) ID>",
  "clientSecret": "<secret value>",
  "enabled": true,
  "enforceSso": false,
  "autoProvision": true,
  "allowedDomains": ["agency.org"]
}
```

| Field            | Meaning                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientSecret`   | Encrypted at rest and never returned. Omit it on later updates to keep the stored one. When the secret expires in Entra, save the new one here.                                                                                                                                             |
| `allowedDomains` | People whose e-mail is in one of these domains may be **linked** to an existing WanSurvey account or **created** on their first Microsoft sign-in. Required when `enabled` is true.                                                                                                         |
| `autoProvision`  | Default true. When false, nobody is created by a first Microsoft sign-in: only people already added or invited get in (anyone else is refused with `not_provisioned`). Omit it to keep the stored choice. `ENTRA_AUTO_PROVISION=false` in the deployment forbids it for every organisation. |
| `enforceSso`     | When true, password sign-in to this organisation is refused, except for its **owners**, who keep a password as a break-glass route.                                                                                                                                                         |

## 3. How sign-in works

1. The web app sends the browser to `GET /api/v1/auth/sso/start?org=<slug>`, or `?email=<address>` to find the organisation from the domain, with an optional `returnTo=/path`.
2. Microsoft authenticates the person (authorization code flow with PKCE) and redirects to the callback.
3. WanSurvey checks the ID token: signature (Microsoft's published keys), issuer, audience, expiry, nonce, and that `tid` is the organisation's Entra tenant. It then finds the person:
   - by the Entra object id (`oid`) linked earlier; or
   - by e-mail, if the domain is allowed: an existing account is linked, otherwise a new account is created.
4. Membership of the organisation:

   | Membership  | Result                                                                                                                                                          |
   | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Active      | Signed in with their roles                                                                                                                                      |
   | Invited     | The invitation is accepted                                                                                                                                      |
   | Deactivated | Refused                                                                                                                                                         |
   | None        | Added as a member **with no role** (refused with `not_provisioned` when the organisation, or the deployment's `ENTRA_AUTO_PROVISION=false`, turns creation off) |

5. The browser returns to `PUBLIC_URL + returnTo` with a session. On failure it goes to `PUBLIC_URL/login?sso_error=<code>`. Possible codes:
   - `sso_not_configured`
   - `choose_organisation`
   - `invalid_state`
   - `microsoft_error`
   - `token_exchange_failed`
   - `invalid_token`
   - `domain_not_allowed`
   - `not_provisioned`
   - `link_required` / `link_not_allowed`
   - `account_disabled`
   - `membership_deactivated`

**People without a role.** Someone created by their first Microsoft sign-in can sign in but do nothing yet:

- `GET /api/v1/auth/me` returns `access.state = "no_role"` with a message for the waiting page.
- Owners and admins get an e-mail, and `GET /api/v1/users` shows the person with `awaitingRole: true`.
- Once an admin assigns a role, access works immediately; no new sign-in is needed.

**Two-factor authentication.** If the ID token's `amr` claim contains `mfa`, WanSurvey does not ask for its own TOTP code. Otherwise its usual rules apply: enrolled users enter a code, and owners and admins must enrol. Use Entra Conditional Access to require MFA for the WanSurvey app.

## 4. The deployment's directory, and Microsoft only (production)

The deployment can set the Microsoft directory once, for every organisation, instead of each organisation entering its own on the Organisation page. The organisation is found from the **e-mail's domain**: the person types their address, and the organisation that lists that domain (and has Microsoft turned on) is the one they sign in to.

```
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_CLIENT_SECRET=<the secret, or a Key Vault reference>
ENTRA_REDIRECT_URI=https://encuestas.example.org/api/auth/entra/callback   # as registered in Entra
ENTRA_ALLOWED_DOMAINS=agency.org          # optional, comma-separated: the domains the directory serves
ENTRA_AUTO_PROVISION=true                 # optional (default true): false forbids creating accounts in every organisation
PASSWORD_LOGIN=false                      # optional: Microsoft only, no passwords
```

- **The secret.** `ENTRA_CLIENT_SECRET` is either the secret itself or a Key Vault reference, `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/)` (or `VaultName=<vault>;SecretName=<name>`). App Service resolves its references before the app starts; anywhere else (a container, a virtual machine) the app reads the secret itself from Key Vault with its managed identity (`AZURE_CLIENT_ID` for a user-assigned one), which needs the _get_ permission on secrets. The value is read when a sign-in finishes and kept for ten minutes.
- **What each organisation keeps.** An organisation turns Microsoft sign-in on, lists its e-mail domains and chooses whether to require it (owners keep a password), on its Organisation page. The directory, client and secret there are the deployment's: shown, not edited (`GET /tenant/sso` answers `managedByDeployment: true`; what `PUT /tenant/sso` carries for them is ignored). With `ENTRA_ALLOWED_DOMAINS` set, only domains in both lists get in, and `PUT` refuses others with 400 `DOMAIN_NOT_ALLOWED`. A domain still belongs to one organisation.
- **The e-mail first.** `GET /api/v1/auth/methods` answers `{ "password": <bool>, "microsoftNeedsEmail": true }`: the sign-in page asks for the address, then opens `sso/start?email=…`. Without an address, `sso/start` answers `choose_organisation`; with a domain no organisation lists, `sso_not_configured`. (There is no default organisation any more: `SSO_DEFAULT_ORG` and `ENTRA_ENFORCE` were removed and stop the app if they are still set.)
- **Passwords off.** `PASSWORD_LOGIN=false` makes `POST /auth/login`, `/auth/password/forgot`, `/auth/password/reset` and `/auth/invitations/accept` answer 403 `PASSWORD_LOGIN_DISABLED` with the `ssoStartUrl`; the reset and invitation pages show the Microsoft button. Someone invited joins by signing in with Microsoft (the invitation is accepted then): the invitation e-mail says to choose "Ingresar con Microsoft" and links to `/accept-invitation?org=<slug>`, which starts `sso/start?org=<slug>` at the organisation that invited them. Owners have no password break-glass route here: keep two owners, and keep the app registration's secret current. Turn Microsoft on for the organisation **before** switching passwords off: nobody could sign in to do it afterwards.
- **Linking by e-mail.** A token's e-mail proves nothing by itself: whoever runs a directory can put any address in it. An existing account that also belongs to other organisations is linked by e-mail only through the deployment's own directory (`ENTRA_*`, run by those who run the installation). Through a directory an organisation configured itself it is refused with `link_required` (sign in with the password first); an administrator adds the person instead. After the first link, every sign-in finds the account by its Entra `oid`.
- **Callback address.** Every app of the family (KPITracker, CienciaDeDatos, WanSurvey) answers Microsoft at `/api/auth/entra/callback`. The former address, `/api/v1/auth/sso/callback`, no longer answers: an Entra app that has only that redirect URI registered fails with `AADSTS50011` until the new one is registered.
- **Startup checks.** The four `ENTRA_*` settings (tenant, client, secret, redirect URI) come together or not at all, and `PASSWORD_LOGIN=false` needs them; `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` must be GUIDs; `ENTRA_REDIRECT_URI` must be an `https` address (`http` only for localhost) ending in `/api/auth/entra/callback`; an empty setting counts as not set. Otherwise the API refuses to start.
- **One directory per session.** A session opens another of the person's organisations only if that organisation has Microsoft sign-in from the same directory; otherwise `switch-tenant` answers `SSO_REQUIRED` and the app sends the browser to that organisation's own sign-in.
- **Start of the day.** Starting a sign-in reads only public settings (no secret); the settings are kept for a minute per process, and a change saved in the app reaches every process at once through Redis. A known account signs in with one transaction (find it by `oid`, open the session).

## The first administrator

A new installation has no organisation and nobody who could create one. `INITIAL_ADMIN_USER`, the **UPN** (user principal name) of the first administrator in Entra ID, starts it:

```
INITIAL_ADMIN_USER=ana@agency.org
```

- **What it does.** When the API starts (after the migrations) and the database has **no organisation at all**, it creates one from the UPN's domain (named after it: `agency.org`, slug `agency-org`) with Microsoft sign-in on for that domain through the deployment's directory (`ENTRA_*`), and the person as its **owner**, invited, with no password. Their first Microsoft sign-in activates the account and links it to their Entra identity; Entra's `mfa` claim stands in for the second factor, otherwise an owner enrols a code as usual. The organisation's name can be changed on the Organisation page; more domains, projects and people are added from the app.
- **Once.** It does nothing when the person already exists, and when the installation already has organisations it only warns (`INITIAL_ADMIN_USER is ignored`): it is not a way into an existing installation. Remove the setting once the first administrator is in.
- **Production and development.** It works the same in both: it needs the four `ENTRA_*` settings (the API refuses to start without them, or with a domain outside `ENTRA_ALLOWED_DOMAINS`), and it needs `DATABASE_ADMIN_URL`, which is set where the migrations run at start (App Service from a zip). With separate migration steps (containers), run the API once with the setting, or create the organisation with the demo seed in development.
- **Not with the demo data.** `db:seed` creates its own organisations; the setting is then ignored.

## Testing against a real tenant

Set these in the API environment:

- `ENTRA_REDIRECT_URI`: Microsoft redirects there; it must match the registered redirect URI exactly. Organisations that use their own directory instead (no deployment settings) get `{PUBLIC_URL}/api/auth/entra/callback`.
- `PUBLIC_URL`: where the browser lands afterwards.

`ENTRA_AUTHORITY_HOST` defaults to `https://login.microsoftonline.com`. Change it only for sovereign clouds (for example `https://login.microsoftonline.us`) or tests. The automated tests use a local mock of Microsoft's token and key endpoints, so they never reach Microsoft.
