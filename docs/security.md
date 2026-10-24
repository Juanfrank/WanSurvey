# Security

How WanSurvey meets spec §12, checked against the [OWASP ASVS 4.0.3](https://owasp.org/www-project-application-security-verification-standard/) level 2. Each chapter lists what is in place, with the code or test that shows it, and what is left to the deployment or a later phase. Status: ✅ in place, ◐ partly (or left to the deployment), — not applicable.

## Summary

| Area                    | Status | Where                                                                                                                                 |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Transport security      | ◐      | TLS terminates at the load balancer; HSTS from the API (production) and nginx                                                         |
| Encryption at rest      | ◐      | Database and backups: the hosting provider's disk encryption. Secrets and personal sample fields: AES-256-GCM in the application (H1) |
| Sessions and CSRF       | ✅     | httpOnly session cookie, hashed session ids, CSRF header on writes                                                                    |
| Rate limits             | ✅     | Login, CAWI links and open links, webhooks (`test/security.test.ts`, `test/rbac.test.ts`)                                             |
| Content-Security-Policy | ✅     | `apps/web/security-headers.ts`, `infra/nginx/templates/default.conf.template`; no violations on any page (`e2e/hardening.spec.ts`)    |
| Dependency scanning     | ✅     | `pnpm audit --prod` in CI                                                                                                             |
| Tenant isolation        | ✅     | Postgres row-level security on every tenant table (`test/rls.test.ts`)                                                                |
| Access control          | ✅     | Role matrix enforced on every endpoint (`test/rbac.test.ts`, 470+ cases)                                                              |
| Audit                   | ✅     | Logins, role changes, publishes, reassignments, answer changes, exports, downloads, personal data views and erasures                  |
| Privacy                 | ✅     | Retention with anonymisation, data subject export and erasure (`test/privacy.test.ts`)                                                |

## V1 Architecture

| Item                             | Status | Notes                                                                                                     |
| -------------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| 1.1 Secure development lifecycle | ✅     | Every change is linted, type-checked, unit and E2E tested in CI; decisions in `docs/decisions.md`         |
| 1.2 Authentication architecture  | ✅     | One auth module (`apps/api/src/auth`); every route is protected unless marked `@Public()`                 |
| 1.4 Access control architecture  | ✅     | Permissions checked server-side by a global guard; the web app only hides what the server forbids         |
| 1.5 Input/output architecture    | ✅     | Every body and query is parsed by a Zod schema (`ZodPipe`); outputs are JSON                              |
| 1.6 Cryptographic architecture   | ✅     | One key (`APP_ENCRYPTION_KEY`) for field encryption; keyed hashes derived from it with HKDF               |
| 1.8 Data classification          | ✅     | Sample fields and questions are marked personal; masking, encryption, exports and erasure follow the mark |
| 1.14 Configuration               | ✅     | Configuration validated at start (`config.ts`); the application connects as a restricted role             |

## V2 Authentication

| Item                      | Status | Notes                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Password security     | ✅     | At least 10 characters, up to 512, any characters; no composition rules or rotation                                                                                                                                                                                                                                                                 |
| 2.1.7 Breached passwords  | ◐      | Not checked against breach lists (needs an outbound service); planned with phase 5                                                                                                                                                                                                                                                                  |
| 2.2 General authenticator | ✅     | Sign-in limited per client address (`LOGIN_RATE_LIMIT` a minute; the address comes from `X-Forwarded-For` only through `TRUST_PROXY_HOPS` proxies); an account locks for `LOGIN_LOCK_MINUTES` (15) after `LOGIN_LOCK_AFTER` (10) failed passwords or codes in a row from any address, the right password included; uniform errors; failures audited |
| 2.4 Credential storage    | ✅     | Argon2id                                                                                                                                                                                                                                                                                                                                            |
| 2.5 Credential recovery   | ✅     | Single-use, expiring reset tokens stored hashed; reset revokes every session                                                                                                                                                                                                                                                                        |
| 2.7/2.8 Second factor     | ✅     | TOTP (RFC 6238) required for owners and admins; secrets encrypted; each code accepted once (the last step is kept); wrong codes count towards the lock                                                                                                                                                                                              |
| 2.x Federation            | ✅     | Microsoft Entra ID with PKCE, nonce and state in an encrypted cookie (`docs/sso-entra.md`)                                                                                                                                                                                                                                                          |

## V3 Session management

| Item                      | Status | Notes                                                                                  |
| ------------------------- | ------ | -------------------------------------------------------------------------------------- |
| 3.2 Session binding       | ✅     | 256-bit random token; only its SHA-256 is stored                                       |
| 3.3 Session termination   | ✅     | Idle (60 min) and absolute (12 h) limits; logout and password reset revoke             |
| 3.4 Cookie-based sessions | ✅     | `httpOnly`, `SameSite=Lax`, `Secure` in production, path `/`                           |
| 3.5 Token-based sessions  | —      | Not used                                                                               |
| 3.7 Re-authentication     | ◐      | Sensitive changes need an active, second-factor session; no re-prompt for the password |

## V4 Access control

| Item                | Status | Notes                                                                                                       |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| 4.1 General         | ✅     | Deny by default; permissions per role and project                                                           |
| 4.2 Operation level | ✅     | Every endpoint × role tested (`test/rbac.test.ts`); tenant data isolated by RLS even if a check were missed |
| 4.3 Other           | ✅     | Admin functions need TOTP; personal data views are audited                                                  |

## V5 Validation, sanitisation and encoding

| Item                 | Status | Notes                                                                                                                       |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| 5.1 Input validation | ✅     | Zod on every input; size limits on bodies (5 MB) and uploads (20 MB, 200,000 rows); compressed request bodies refused (415) |
| 5.2 Sanitisation     | ✅     | Rich text in questionnaires is a restricted subset rendered as React elements, never as raw HTML; e-mails are plain text    |
| 5.3 Output encoding  | ✅     | React escapes output; the only raw markup is the QR code SVG the browser generates itself                                   |
| 5.3.4 SQL injection  | ✅     | Parameterised queries (Drizzle, postgres.js); identifiers never come from input                                             |
| 5.5 Deserialisation  | ✅     | JSON only; questionnaire logic is parsed by our own parser, never evaluated as code                                         |

## V6 Stored cryptography

| Item                  | Status | Notes                                                                                                            |
| --------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| 6.2 Algorithms        | ✅     | AES-256-GCM with random 96-bit IVs; HMAC-SHA-256; Argon2id; SHA-256 for token lookups                            |
| 6.3 Random values     | ✅     | `crypto.randomBytes` for every token                                                                             |
| 6.4 Secret management | ◐      | The key comes from the environment; a secrets manager (and key rotation, `v1.` prefix ready) is the deployment's |

## V7 Errors and logging

| Item               | Status | Notes                                                                                                    |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------------- |
| 7.1 Log content    | ✅     | Structured logs (pino); cookies, CSRF tokens and set-cookie redacted; no answers or personal data logged |
| 7.2 Log processing | ✅     | Security events in the audit log, which the application role can only append to                          |
| 7.4 Error handling | ✅     | Errors return a code and message, never stack traces                                                     |

## V8 Data protection

| Item                       | Status | Notes                                                                                                                                                                 |
| -------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 General                | ✅     | Exports and downloads audited; files kept with the request and protected by RLS                                                                                       |
| 8.2 Client-side            | ✅     | Offline CAPI data in IndexedDB is limited to downloaded cases and cleared on check-in                                                                                 |
| 8.3 Sensitive private data | ✅     | Personal fields masked without `pii.view`; encrypted at rest (H1); personal answers left out of exports for people without `pii.view`; retention and erasure (H2, H3) |

## V9 Communications

| Item                      | Status | Notes                                                                                         |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| 9.1 Client communications | ◐      | TLS 1.2+ at the load balancer (deployment); HSTS sent                                         |
| 9.2 Server communications | ◐      | SMTP over TLS (`smtps://`), Microsoft over HTTPS; database and Redis inside a private network |

## V10 Malicious code

| Item                       | Status | Notes                                                                                                                                                                       |
| -------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.3 Application integrity | ✅     | Dependencies pinned through the lockfile, `--frozen-lockfile` in CI; `pnpm audit --prod --audit-level high` fails the build, with dated exceptions in `pnpm-workspace.yaml` |

## V11 Business logic

| Item | Status | Notes                                                                                                                                    |
| ---- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 11.1 | ✅     | Interviews are re-run by the server's engine on submit; corrections must leave a complete interview; status changes follow a fixed table |

## V12 Files and resources

| Item          | Status | Notes                                                                 |
| ------------- | ------ | --------------------------------------------------------------------- |
| 12.1 Upload   | ✅     | Size and row limits; CSV/XLSX parsed in memory, never stored as files |
| 12.5 Download | ✅     | `Content-Disposition: attachment`, fixed content types, `nosniff`     |
| 12.6 SSRF     | ✅     | Only configured hosts are called (geocoder, Microsoft, SMTP)          |

## V13 API

| Item         | Status | Notes                                                             |
| ------------ | ------ | ----------------------------------------------------------------- |
| 13.1 Generic | ✅     | OpenAPI at `/docs`; JSON content types only                       |
| 13.2 RESTful | ✅     | CSRF header on every state change; CORS not enabled (same origin) |

## V14 Configuration

| Item                       | Status | Notes                                                                                                                                      |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 14.2 Dependencies          | ✅     | `pnpm audit` in CI; new dependencies pinned to versions at least two weeks old                                                             |
| 14.4 HTTP security headers | ✅     | CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, HSTS (production) |
| 14.5 Request headers       | ✅     | `trust proxy` set to one hop for client addresses behind the load balancer                                                                 |

## Personal data (GDPR-ready)

- **Consent** per contact (e-mail and phone) is recorded and respected by waves and the call queue.
- **Masking**: personal sample fields and contacts are masked for people without `pii.view`; every reveal is audited.
- **Encryption** (H1): personal sample fields are sealed with AES-256-GCM per case; a keyed hash of each word lets authorised people search by name.
- **Retention** (H2): per project, finished cases lose their personal data after a set number of days, every night.
- **Data subject requests** (H3): export everything held about a case as JSON, or erase its personal data, from the case; both audited.
- **Data residency**: one region in the MVP; a tenant setting later.
