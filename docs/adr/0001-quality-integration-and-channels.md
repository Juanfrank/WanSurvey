# ADR 0001: Audit, fraud signals, integrations and new channels

- **Status:** accepted; implemented so far: decisions 1 (audit export, RLS coverage test, erasure scan), 2 (fraud risk score) 3 (API keys, read only, and outgoing webhooks; see [the integration API](../integration-api.md)) and 4 (SMS, see [operations](../operations.md)); the rest pending
- **Date:** 2026-11-02
- **Deciders:** product owner
- **Scope:** what to build next, in which order and in which form. Decisions are built in the order given below.

## Context

A review of comparable products (KoboToolbox, ODK Central, SurveyCTO, Survey Solutions, Nfield, REDCap, Formbricks, LimeSurvey, Qualtrics) and of what their users ask for, checked against this code base, left a short list of gaps. What WanSurvey already has, and is **not** decided again here:

- quality flags on submitted interviews: speed and straight-lining (`apps/api/src/review/flags.ts`), with human review, a random sample and "return with comments";
- paradata, including the device position at the start and at the end of a web interview (`gps` events);
- an append-only audit log (D14) read by `GET /api/v1/audit-log` with the `audit.read` permission;
- background jobs kept in the database with a claim by conditional update, retries, and a sweeper that requeues what waited too long (`apps/api/src/jobs`); they run without Redis;
- a `Mailer` port with console, file and SMTP adapters and an idempotency key per message (D15);
- file storage behind a port with Azure Blob and local adapters, reached with the app's managed identity (`exports/storage.ts`);
- retention with anonymisation, and data subject export and erasure (`privacy`);
- an installable PWA with a service worker (`apps/web/service-worker.ts`) and a per-user light/dark theme (`ws.theme`, follows the system by default);
- an organisation `branding` column (JSON), not yet used for the theme;
- OpenAPI at `/docs`, and sessions with cookie and CSRF token as the only way in.

The deployment is one App Service instance running the API and the worker in one process, with or without Redis (`docs/appservice-zip.md`). Every decision below has to work like that, and not need a second instance.

## Order

Decided by value over cost, with the dependencies between them:

| Order | Decision                                          | Why here                                                          |
| ----- | ------------------------------------------------- | ----------------------------------------------------------------- |
| 1     | Audit export and deletion/isolation tests         | Small, and makes every later feature safer to add                 |
| 2     | Fraud risk score                                  | Uses data already collected; improves what the review queue sees  |
| 3     | Integration API with keys, then outgoing webhooks | The largest and the one that unlocks the most; in two phases      |
| 4     | SMS channel                                       | Reuses the delivery pattern of 3; only if the population needs it |
| 5     | Interview audio in Blob Storage                   | Reuses the storage port and the risk score; the most sensitive    |
| 6     | Web notifications                                 | Reuses the delivery pattern of 3                                  |
| 7     | Per-organisation theme                            | Small and independent                                             |

Not decided here, and kept out on purpose: survey weighting and calibration, SCIM provisioning, XLSForm/DDI import and export.

## Decision 1: audit export, and tests of deletion and isolation

**Form.** Export of the audit log, and two kinds of automated test. No new data is collected.

- `GET /api/v1/audit-log/export?from&to&actor&action&format=csv|jsonl`, streamed with keyset pagination as the data exports are (constant memory), a bounded range per request (366 days), and a new permission `audit.export` (owners by default, configurable like the others) apart from `audit.read`. Every export is itself written to the audit log (`audit.exported`: filter and row count).
- A schema test: every table with a `tenant_id` column has a row-level-security predicate. A table added without one fails the build.
- An isolation test through the HTTP API: for each tenant-scoped resource, a user of organisation A gets 404 or an empty list for B's identifiers.
- An erasure test: after a data subject's erasure or the retention job, no personal value remains in the tables, in the files in storage, or in queued job payloads.

**Benefit.** An auditor can be handed a file instead of access; the isolation and erasure guarantees stop depending on a person remembering them.

**Cost and risks.** The log holds e-mail addresses and IPs: the export is personal data, so it needs its own permission and its own audit entry. A generic schema test can be noisy for tables that are global on purpose (accounts, identities): they go on an explicit list with a reason.

## Decision 2: fraud risk score

**Form.** Extend the flags with signals that point to invented interviews, shown to reviewers as one ordered list. A person decides; nothing is rejected automatically.

- New flags next to `speeding` and `straightlining`: `shortPages` (pages answered in less than a fraction of the project's median), and `positionCluster` (several interviews of one interviewer started within a few metres of each other, or far from the case's geocoded address).
- A `risk` value that adds the weights of the flags that fired, with the list of reasons kept, so the reviewer sees why. Thresholds are project settings with conservative defaults.
- Computed in the worker after a submission and again every night per interviewer (the cluster signal needs the others). The review queue can be sorted by risk; the random sample stays, to calibrate the thresholds.
- The device position is optional per project, with the notice to the interviewer and the respondent that the law of the country requires; positions are kept as long as the other paradata and anonymised with them.

**Benefit.** The cheapest defence against fabricated interviews, using paradata already collected; reviewers' time goes where the risk is.

**Cost and risks.** False positives (rural areas, poor GPS, interviews in a market or a school): hence thresholds that can be tuned and a human decision. The position of a person's home is personal data. A score can be read as proof: the screen shows reasons, not a verdict.

## Decision 3: integration API with keys, then outgoing webhooks

**Form.** Two phases, each releasable on its own.

### Phase A: API keys, read only

- A separate, versioned surface under `/api/v1/ext/` with its own controllers and OpenAPI tag. The web app's internal routes stay free to change; the external contract does not.
- Key format `wsk_<id>_<secret>`: the id in clear for lookup, only the SHA-256 of the secret stored (it is long and random, so no slow hash is needed), shown once at creation.
- Per organisation, created by someone with a new permission `apikeys.manage`; each key has a name, scopes (`projects:read`, `cases:read`, `interviews:read`, `exports:read`, `audit:read`), an optional project restriction, a required expiry (at most one year), an optional list of allowed addresses, `last_used_at` and revocation. The scopes never include personal data unless `pii:read` is given and audited; without it values are masked as for users without `pii.view`.
- The key acts inside the organisation's row-level security as every request does. Bearer authentication, no cookie, no CSRF.
- A rate limit per key (shared through Redis when it exists, in memory otherwise: documented as one instance only). The `Authorization` header joins the redacted headers of the request log.
- Writes (create cases, change statuses) come later, scope by scope.
- _As built:_ the scopes are `projects:read`, `cases:read`, `interviews:read` and `audit:read`; `pii:read` and `exports:read` are left out of this step. Personal data never leaves through a key (masked sample fields, interviews without answers), which keeps the first release free of the question of which variables of which questionnaire version are personal. Answers will come with `exports:read` or a masked answers route.

### Phase B: outgoing webhooks

- Endpoints per organisation (optionally per project) subscribed to a small set of events: `interview.submitted`, `interview.status_changed`, `export.ready`, `case.status_changed`.
- Signed as the Standard Webhooks specification says (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256, a `whsec_` secret shown once, two secrets valid at once for rotation) by a small module of our own (`webhooks/signing.ts`, tested against the specification's example) instead of the `standardwebhooks` package: it is ten lines of HMAC and avoids a dependency. The e-mail to administrators when an endpoint is switched off is not built yet.
- Payload with identifiers and timestamps only; details are fetched through phase A. No personal data in a webhook body.
- Delivery kept in the database (`webhook_deliveries`: attempt, next attempt, status, response code, duration), claimed like the jobs, so it works without Redis and survives a restart. Retries at 1 min, 5 min, 30 min, 2 h, 12 h, 24 h; after that, or after a run of failures, the endpoint is disabled and the administrators are told by e-mail. A failed delivery can be redelivered by hand from the screen.
- Safe by construction against server-side request forgery: `https` only, the address resolved and refused if it is loopback, private, link-local or the cloud metadata address, no redirects followed, a 10-second timeout and a cap on the response read.

**Benefit.** Power BI, n8n and the institution's own systems connect without database access; the biggest unlock of the list.

**Cost and risks.** The largest item. It opens an attack surface that did not exist (keys that leak, requests the server makes on a customer's behalf), so it needs the isolation tests of decision 1 first, key rotation and revocation, and a stable contract to maintain. With one instance, rate counters and in-flight deliveries depend on the process staying up: the database-kept deliveries cover the second, not the first.

## Decision 4: SMS channel for web surveys

**Form.** A third channel next to e-mail and links in the CAWI waves, through a port.

- An `SmsProvider` port like `Mailer`: console and file adapters for development and tests, and one real adapter. **The provider is open:** the criteria are coverage of the countries where the fieldwork happens, price, sender-ID rules, delivery receipts, and handling of opt-out. Azure Communication Services is the natural candidate for being in the same cloud, and its coverage of the target countries must be confirmed before choosing. Unofficial WhatsApp libraries are out: they go against the service's terms.
- Reuses what e-mail has: the invitation and reminder templates (with the short survey link), the lawful-basis check, the idempotency key, the send funnel, the unsubscribe list (shared across channels) and the telephone numbers already normalised to E.164. Opt-out ("STOP") comes back through the provider's inbound webhook and adds to that list.
- Send only inside the respondent's allowed hours (the CATI calling hours already know the time zone).
- Cost guard: the wave preview shows recipients, message segments and the estimated cost from a price setting; sending above a threshold asks for a second confirmation.
- New settings (`SMS_PROVIDER`, the sender, the credentials, best as Key Vault references) go to the `appconfig/` templates, which a test keeps in step with the code.
- _As built:_ the provider is Azure Communication Services through its REST API (no SDK), plus console, file and in-memory adapters; the SMS text is fixed per language (short, with the link and the way out) and is not yet editable per project; delivery receipts are not read; the ACS adapter has not been run against a live resource.

**Benefit.** Higher response in populations without a working e-mail address, with a link that opens on the phone they already have.

**Cost and risks.** Cost per message; sender registration and telecom rules that vary by country; delivery that varies by operator; a third party processing personal data; phone numbers that are wrong or shared.

## Decision 5: interview audio, stored in Blob Storage

**Form.** Optional, per project, for quality review of a sample of interviews.

- **Consent first.** Recording starts only after the respondent's consent, captured as a step of the interview with the version of the text, in the respondent's language, and kept as paradata. Without consent nothing is recorded and the interview goes on.
- **Sampling.** A project setting decides the share of interviews recorded (drawn on the server when the interview starts) and whether the whole interview or only marked questions are recorded (short clips, as in the CARI method), which limits volume and exposure.
- **Capture.** In the browser with `MediaRecorder`, mono Opus (`audio/webm`; `audio/mp4` on Safari) at about 24 kbps, which is roughly 11 MB per hour. Segments of 30 seconds are kept in IndexedDB while there is no connection and sent with the numbered sync batches, idempotent, and assembled on the server.
- **Storage.** A private container `interview-audio` in the same storage account (no public access, no account keys, role for the app's identity), written **through the API** as the exports are, with the same storage port and managed identity. The client never receives a signed link. Blob keys: `tenant/project/interview/segment`. Metadata in SQL (`interview_audio`: interview, segment, bytes, duration, SHA-256, upload time) under row-level security.
- **Listening.** Only in the review screen, for a new permission `audio.listen`, streamed by the API with range requests; every listening is written to the audit log (`audio.listened`).
- **Life of the files.** Kept a project-set number of days after the interview is approved (90 by default), deleted by the nightly retention job, with a Blob lifecycle rule as a backstop in `main.bicep`. The erasure of a data subject deletes the audio of their interviews (the test of decision 1 covers it). At rest, Azure's storage encryption; a customer-managed key can follow.
- The risk score of decision 2 can send flagged interviews to the audio queue first.

**Benefit.** The strongest check against fabricated interviews, and the evidence for a disputed one.

**Cost and risks.**

- **Privacy:** the most sensitive data of the product, and the voice of third parties. The legal basis, the consent wording, the retention period and who may listen must be agreed with the institution's legal area before building (the applicable personal-data law, for example Law 172-13 in the Dominican Republic, is to be confirmed by them, not assumed here).
- **Cost:** at about 8 MB for a 45-minute interview, recording 10 % of 10,000 interviews is around 8 GB; recording all of them, about 80 GB, plus reading them back.
- **Devices:** battery and processor on tablets, microphone permission, IndexedDB quota pressure when offline, and different recorders per browser.
- **People:** someone has to listen; a 10 % sample is only useful if a reviewer has the time.

## Decision 6: web notifications

**Form.** Web Push with VAPID, through the service worker that already exists.

- Opt-in per user from the account menu, by category: callbacks due (CATI), new assignments, an interview returned, an export ready, a wave finished. A table of subscriptions per user and device, under row-level security; a subscription that answers 404 or 410 is deleted.
- The payload is generic and holds no personal data ("You have 2 callbacks due"); tapping it opens the right screen.
- Sent through the delivery pattern of decision 3 (kept in the database, retried). Callbacks need a tick every minute that looks at the next five minutes, in the process that already runs the sweeper.
- New settings `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (a secret) and `VAPID_SUBJECT` go to the `appconfig/` templates. The `web-push` package (MPL-2.0, 3.6.7) was last published in January 2024: it is used pinned, and if it stays unmaintained the protocol (RFC 8291 and RFC 8188) is small enough to implement over `node:crypto`.

**Benefit.** An interviewer does not miss a callback, and a reviewer sees a return without refreshing.

**Cost and risks.** No delivery guarantee; browsers differ, and on iOS it works only for the installed app (16.4 or later); too many notifications make people turn them off; the push services see the metadata; the maintenance of the library.

## Decision 7: per-organisation theme

**Form.** The dark mode itself exists, per user. What is added is a **default per organisation**, in the `branding` column that already exists.

- The organisation chooses a default (light, dark, or follow the system) for people who have not chosen their own, and an accent colour from a **limited palette**, not free CSS.
- Each palette colour is checked for contrast (4.5:1 for text) in both themes when it is saved and in the accessibility tests, so the WCAG 2.2 AA result of `docs/accessibility.md` holds.
- The logo and name already travel with the project; the respondent pages follow the respondent's own system preference.

**Benefit.** The product looks like the institution's, at little cost, without breaking accessibility.

**Cost and risks.** A palette is less free than asking for a colour; every colour doubles the visual test matrix; an organisation default can clash with a user's habit, so a personal choice always wins.

## Consequences of the whole

- Three new permissions (`audit.export`, `apikeys.manage`, `audio.listen`), new tables (`api_keys`, `webhook_endpoints`, `webhook_deliveries`, `push_subscriptions`, `interview_audio`) and new settings (SMS, VAPID, audio retention) reach the schema, the role editor, the `appconfig/` templates and the Bicep file; the tests that keep these in step with the code catch what is forgotten.
- Items 3, 4 and 6 share one delivery mechanism kept in the database, so it is built once, in item 3.
- Items 2 and 5 depend on the paradata and on the position being allowed by the project; the legal questions of item 5 can stop it without stopping the rest.
- Single-instance limits stay: counters in memory and deliveries in flight are lost with a restart; what must survive is kept in the database.

## Alternatives considered

- **Webhooks only, no API:** shorter, but the receiver then cannot fetch the details a body without personal data leaves out.
- **GraphQL instead of REST for the external API:** more flexible for clients, harder to scope by key and to rate limit; the OpenAPI tooling already in use points to REST.
- **Signed links (SAS) for audio playback:** less load on the API, but a link can be forwarded; streaming through the API keeps every listening in the audit log.
- **Recording every interview:** simpler, and ten times the storage, the exposure and the listening time; sampling is the default and a project can raise it.
- **A message queue service for webhook delivery:** one more service to run; the database-kept deliveries already work with one process and without Redis.
- **Free colours for the organisation theme:** cannot guarantee contrast.

## Open questions

1. Which SMS provider, and does it cover the countries of the fieldwork?
2. The legal basis, consent wording and retention for audio, agreed with the legal area before decision 5 starts.
3. Is there demand for weighting and calibration (kept out of this record), and would it be a service apart or an export for R or Python?
4. Will the deployment stay at one instance? If it moves to several, counters and deliveries in memory must move to Redis first.
