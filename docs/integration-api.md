# Integration API

A read-only API for other systems (Power BI, n8n, an institution's own services) to read an organisation's data **without database access and without a person's account**. It is decision 3, phase A, of [ADR 0001](adr/0001-quality-integration-and-channels.md); outgoing webhooks are phase B.

## Keys

An owner creates keys in **Administration → API keys** (permission `apikeys.manage`, owners only by default). Each key has:

- a name,
- scopes: `projects:read`, `cases:read`, `interviews:read`, `audit:read`,
- optionally one project (the key then sees only that project and cannot read the organisation's log),
- an expiry, at most 366 days ahead,
- optionally a list of addresses or CIDR ranges it may be used from.

The key looks like `wsk_<12 hex>_<43 characters>` and is shown **once**, when it is created. Only the SHA-256 of its secret is stored, so a lost key cannot be recovered: revoke it and make another. Revoking works at once. Creation and revocation are in the activity log (`apikey.created`, `apikey.revoked`); the list shows when each key was last used.

## Calling it

```
GET /api/v1/ext/v1/projects
Authorization: Bearer wsk_0123456789ab_…
```

No cookie and no CSRF header are used; a session cookie is not accepted on these routes and a key is not accepted anywhere else. Every failure to authenticate answers the same `401 INVALID_API_KEY` (unknown, wrong secret, revoked, expired, address not allowed). A key without the route's scope gets `403 MISSING_SCOPE`. A key is limited to 600 requests a minute (`429`); the counters are shared through Redis when it is configured, and per instance otherwise.

| Route                                  | Scope             | Answer                                                                            |
| -------------------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| `GET /ext/v1/projects`                 | `projects:read`   | `{ data: [{ id, code, name, status, timezone, languages, modes, createdAt }] }`   |
| `GET /ext/v1/projects/:id/cases`       | `cases:read`      | `{ data: [case], next }`; `?status=&limit=&after=`; personal sample fields masked |
| `GET /ext/v1/projects/:id/interviews`  | `interviews:read` | `{ data: [interview], next }`; `?status=&since=&limit=&after=`; no answers        |
| `GET /ext/v1/audit-log?limit=&action=` | `audit:read`      | `{ data: [entry] }`, newest first                                                 |

Lists are paged with a cursor: pass the `next` of a page as `after` of the next request; `next` is `null` on the last page (`limit` up to 1000, default 200). Cases are ordered by their id (creation order) and interviews by start time.

**Personal data never leaves through a key.** Personal sample fields come masked (`•••`), contacts are not exposed, and interviews come without answers. Answers and the full data set are obtained with the data exports (Analysis → Export), which a person with the right permission runs and audits; reading answers through keys needs a decision about personal variables (their masking by questionnaire version) and is left for a later step, together with the `exports:read` scope.

The shapes only grow: new fields may appear, none changes or disappears within `v1`.

## Security notes

- The `Authorization` header is redacted from the request log.
- A key acts inside the organisation's row-level security like any request; the database finds it through an owner procedure (`api_key_lookup`) and nothing else crosses organisations.
- Put the keys of production systems in a secret store (Key Vault, the secret store of the tool that calls); give each system its own key with the fewest scopes and the shortest expiry that suit it, and restrict it to the project and addresses it needs.
