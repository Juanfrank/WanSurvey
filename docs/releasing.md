# Versions, changelog and releases

How WanSurvey is versioned, how changes are written down, and how a release is made. The history
is in [`CHANGELOG.md`](../CHANGELOG.md); planned work is in [`roadmap.md`](roadmap.md).

## One version for the product

The whole repository has **one version**, [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
(`MAJOR.MINOR.PATCH`, optionally `-rc.1`). It is in the root `package.json` and repeated in every
workspace `package.json`; `node scripts/release.mjs check` (in CI) fails if one differs or if the
CHANGELOG disagrees. The packages are private and ship together, so they are not versioned apart.
The API reports it in its OpenAPI document (`/docs`) and in the start-up log line. `/health`
does not carry it: it is public and says nothing about what runs.

The version names a **release**, tagged `vMAJOR.MINOR.PATCH` in git. Between releases the files
keep the version of the last release; the work in progress is under `[Unreleased]` in the CHANGELOG.

## What the version promises

SemVer needs a public interface. The web app and the API are built and deployed together, so
the paths the web app calls are **not** a promise. These are:

| Interface                                                                       | Where it is described                                             |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Integration API `/api/v1/ext/v1/**`                                             | [`integration-api.md`](integration-api.md), OpenAPI               |
| Outgoing webhooks: event names, body, signature                                 | [`integration-api.md`](integration-api.md)                        |
| Settings: names and meaning of environment variables and `appconfig/` templates | `apps/api/.env.example`, [`appservice-zip.md`](appservice-zip.md) |
| Files and tables made for others: export layouts and the `bi` schema            | [`bi.md`](bi.md), [`operations.md`](operations.md)                |
| The questionnaire definition format, and the stored versions that use it        | `packages/schema`, [`logic-language.md`](logic-language.md)       |
| Upgrading: the migrations and the order of steps                                | this page                                                         |

A change is **breaking** when someone running or integrating WanSurvey has to act for it to keep
working: a removed or renamed field, event, setting or column; a new required setting; a narrower
accepted value; a stricter permission on something that worked. Adding an optional field, event
or setting is not.

| Change                                          | Bump                                           |
| ----------------------------------------------- | ---------------------------------------------- |
| Bug fixes and security fixes that break nothing | patch                                          |
| New features, compatible changes, deprecations  | minor                                          |
| A breaking change                               | major (**minor while below 1.0.0**, see below) |

### Alpha, beta and release candidates

A pre-release has a hyphen and a channel: `0.1.0-alpha.7`, `0.1.0-beta.2`, `0.1.0-rc.1`; it ranks
below the plain `0.1.0` it leads to (SemVer item 11).

| Channel | Means                                                                                            | Made with              |
| ------- | ------------------------------------------------------------------------------------------------ | ---------------------- |
| `alpha` | Features are still arriving and anything may change between two alphas. **All versions so far.** | `pnpm release alpha`   |
| `beta`  | The features of the version are in; it is being tried in real conditions; fixes only             | `pnpm release beta`    |
| `rc`    | A candidate for the plain version: nothing is added unless a defect needs it                     | `pnpm release rc`      |
| (none)  | The release; `pnpm release release` drops the hyphen from the current pre-release                | `pnpm release release` |

`pnpm release alpha` takes `0.1.0-alpha.7` to `0.1.0-alpha.8`; `beta` from an alpha starts at
`beta.1`. The versions up to `0.1.0-alpha.18` were reconstructed from the git history (see the
CHANGELOG): one per stage of the work, tagged on the commit that closes it. `scripts/tag-history.sh` creates those tags
(`--push` also pushes them) from a clone that holds the whole branch.

### Before 1.0.0

`0.y.z` is initial development (SemVer item 4): anything may change. We still keep it orderly:
a **breaking** change raises the minor (`0.2.0` to `0.3.0`), a patch never breaks anything, and
every breaking change is in the CHANGELOG with an **Upgrade** note. [`roadmap.md`](roadmap.md)
lists what has to be true for 1.0.0; from then on the table above applies as written.

### Deprecation

Something that will go away is first marked under **Deprecated** in the CHANGELOG, with what to
use instead, and stays for at least one minor release and 90 days (the integration API and the
webhooks), then goes in the next major. A breaking change to the integration API is a new path
(`/ext/v2`) next to the old one, not an edit of `v1`. When the first deprecation happens, the
response will also carry the `Deprecation` and `Sunset` headers (RFC 9745, RFC 8594).

### Upgrades and the database

Migrations (`apps/api/mssql/`) only go forward and run in order when the application starts, so
any release can be upgraded to any later release of the same major version in one step. There
is no downgrade: to go back, restore the backup taken before the upgrade and deploy the old
zip. A migration that cannot run while the old version is still serving (a column that is
dropped or tightened) is done in two releases: the first adds and starts using the new shape,
the second removes the old one, and the CHANGELOG says so.

## The changelog

[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/): newest release first, an
`[Unreleased]` section on top, ISO dates, link references at the foot, and the sections
**Added, Changed, Deprecated, Removed, Fixed, Security**. A release that was pulled is marked
`[YANKED]`.

- It is written **for the reader** (the operator, the administrator, the integrator), not copied
  from commits: one line per change that someone would notice, in the words of what they see.
- A change that needs action starts the entry with **Upgrade:** and says what to do.
- Whoever makes a change that someone would notice adds the entry in the same commit, under
  `[Unreleased]`. Refactoring, tests and internal tooling need none.
- Security fixes are listed under **Security** once they are public.

## Commit messages

[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), from now on (older
history is free-form):

```
<type>(<scope>)<!>: <what changed, imperative, lower case>

<why, if it is not obvious>

BREAKING CHANGE: <what breaks and what to do>      (only when it does)
```

| Type                                                       | Means                  | Changelog / bump                                                 |
| ---------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `feat`                                                     | a capability           | Added or Changed / minor                                         |
| `fix`                                                      | a defect               | Fixed or Security / patch                                        |
| `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore` | no change in behaviour | usually none                                                     |
| `!` after the type, or a `BREAKING CHANGE:` line           | an incompatible change | Changed or Removed with **Upgrade:** / major (minor below 1.0.0) |

Scopes are the modules: `cati`, `capi`, `cawi`, `papi`, `review`, `designer`, `auth`, `api`,
`web`, `worker`, `infra`, `docs`.

## Making a release

1. CI is green on the branch, and `[Unreleased]` says what changed. Check it against
   `git log <last tag>..HEAD`: nothing noticeable missing, nothing internal listed.
2. Choose the bump with the table above: `pnpm release alpha` (or `beta`, `rc`, `release`,
   `minor`, `major`, `patch`, an exact `1.0.0-rc.1`). `pnpm release minor --dry-run` shows the section without writing anything.
   The script moves `[Unreleased]` under the new version with today's date, fixes the link
   references and sets the version in every `package.json`.
3. Read the diff and fix the words. Commit: `chore(release): vX.Y.Z`.
4. When CI is green on that commit: `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin vX.Y.Z`.
5. Publish the release on GitHub from the tag, with the text of
   `node scripts/release.mjs notes X.Y.Z` as its notes, and deploy the zip that CI built for that
   commit ([`appservice-zip.md`](appservice-zip.md)).
6. Update [`roadmap.md`](roadmap.md): what shipped leaves it (the CHANGELOG has it now), and
   _Now / Next / Later_ is looked at again.

A release candidate (`X.Y.Z-rc.N`) is made the same way and deployed to staging only; it is a
pre-release on GitHub. A **fix to an older release** is made on a branch `release/X.Y` from its
tag, released as a patch, and the same commit is brought back to the main branch.
