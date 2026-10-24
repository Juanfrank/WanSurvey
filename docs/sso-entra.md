# Microsoft sign-in (Entra ID / Azure AD)

Each WanSurvey organisation can let its staff sign in with their Microsoft work accounts. The organisation connects **its own** Entra tenant, so every agency controls its own directory, Conditional Access and MFA.

## 1. Register an app in Microsoft Entra

In the Microsoft Entra admin center, go to **App registrations → New registration**:

| Setting                 | Value                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                    | `WanSurvey`                                                                                                                                  |
| Supported account types | _Accounts in this organizational directory only_ (single tenant)                                                                             |
| Redirect URI            | Platform **Web**, set to the `redirectUri` shown by `GET /api/v1/tenant/sso`, for example `https://api.example.org/api/v1/auth/sso/callback` |

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
  "allowedDomains": ["agency.org"]
}
```

| Field            | Meaning                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientSecret`   | Encrypted at rest and never returned. Omit it on later updates to keep the stored one. When the secret expires in Entra, save the new one here.                                     |
| `allowedDomains` | People whose e-mail is in one of these domains may be **linked** to an existing WanSurvey account or **created** on their first Microsoft sign-in. Required when `enabled` is true. |
| `enforceSso`     | When true, password sign-in to this organisation is refused, except for its **owners**, who keep a password as a break-glass route.                                                 |

## 3. How sign-in works

1. The web app sends the browser to `GET /api/v1/auth/sso/start?org=<slug>`, or `?email=<address>` to find the organisation from the domain, with an optional `returnTo=/path`.
2. Microsoft authenticates the person (authorization code flow with PKCE) and redirects to the callback.
3. WanSurvey checks the ID token: signature (Microsoft's published keys), issuer, audience, expiry, nonce, and that `tid` is the organisation's Entra tenant. It then finds the person:
   - by the Entra object id (`oid`) linked earlier; or
   - by e-mail, if the domain is allowed: an existing account is linked, otherwise a new account is created.
4. Membership of the organisation:

   | Membership  | Result                             |
   | ----------- | ---------------------------------- |
   | Active      | Signed in with their roles         |
   | Invited     | The invitation is accepted         |
   | Deactivated | Refused                            |
   | None        | Added as a member **with no role** |

5. The browser returns to `PUBLIC_WEB_URL + returnTo` with a session. On failure it goes to `PUBLIC_WEB_URL/login?sso_error=<code>`. Possible codes:
   - `sso_not_configured`
   - `choose_organisation`
   - `invalid_state`
   - `microsoft_error`
   - `token_exchange_failed`
   - `invalid_token`
   - `domain_not_allowed`
   - `account_disabled`
   - `membership_deactivated`

**People without a role.** Someone created by their first Microsoft sign-in can sign in but do nothing yet:

- `GET /api/v1/auth/me` returns `access.state = "no_role"` with a message for the waiting page.
- Owners and admins get an e-mail, and `GET /api/v1/users` shows the person with `awaitingRole: true`.
- Once an admin assigns a role, access works immediately; no new sign-in is needed.

**Two-factor authentication.** If the ID token's `amr` claim contains `mfa`, WanSurvey does not ask for its own TOTP code. Otherwise its usual rules apply: enrolled users enter a code, and owners and admins must enrol. Use Entra Conditional Access to require MFA for the WanSurvey app.

## 4. Microsoft only, with one button (production)

With `PASSWORD_LOGIN=false` the sign-in page shows only **Ingresar con Microsoft**: no e-mail, no password, no "forgot password" link. The deployment, not an owner in the app, says where the button goes:

```
PASSWORD_LOGIN=false
SSO_DEFAULT_ORG=<slug of the organisation>
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_CLIENT_SECRET=<secret value, from Key Vault>
ENTRA_ALLOWED_DOMAINS=agency.org          # comma-separated
```

- **The button.** `GET /api/v1/auth/methods` answers `{ "password": false, "microsoftNeedsEmail": false }`; the button then opens `sso/start` with no e-mail, which signs in to `SSO_DEFAULT_ORG` through the `ENTRA_*` app registration. With those four set, that organisation's own `PUT /tenant/sso` settings are not used, and no other organisation can claim those domains.
- **Passwords off.** `POST /auth/login`, `/auth/password/forgot`, `/auth/password/reset` and `/auth/invitations/accept` answer 403 `PASSWORD_LOGIN_DISABLED` with the `ssoStartUrl`; the reset and invitation pages show the Microsoft button. Someone invited joins by signing in with Microsoft (the invitation is accepted then, step 4 above). Owners have no password break-glass route here: keep two owners, and keep the app registration's secret current.
- **Linking by e-mail.** An account first signs in with Microsoft by its e-mail in an allowed domain, even if it belongs to other organisations too (there is no password to prove it with, and domains are unique to one organisation). The Entra `oid` is linked then; every later sign-in finds the account by `oid`.
- **One directory per session.** A session opens another of the person's organisations only if that organisation has Microsoft sign-in from the same directory; otherwise `switch-tenant` answers `SSO_REQUIRED` and the app sends the browser to that organisation's own sign-in.
- **Start of the day.** The settings are read once a minute per process, and a known account signs in with one transaction (find it by `oid`, open the session); see `load/results.md`.

## Testing against a real tenant

Set these in the API environment:

- `API_PUBLIC_URL`: the public URL Microsoft redirects to, which must match the registered redirect URI exactly.
- `PUBLIC_WEB_URL`: where the browser lands afterwards.

`ENTRA_AUTHORITY_HOST` defaults to `https://login.microsoftonline.com`. Change it only for sovereign clouds (for example `https://login.microsoftonline.us`) or tests. The automated tests use a local mock of Microsoft's token and key endpoints, so they never reach Microsoft.
