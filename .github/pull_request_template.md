## What and why

<!-- What changes for the people who use, run or integrate WanSurvey, and why. -->

## Checklist

- [ ] Commit messages follow Conventional Commits (`feat(cati): …`, `fix(api): …`; `!` or `BREAKING CHANGE:` for an incompatible change) — [`docs/releasing.md`](../docs/releasing.md)
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` if someone would notice the change (with an **Upgrade:** note if they must act)
- [ ] A breaking change to the integration API, webhooks, settings, exports or questionnaire format is called out, and the bump is decided (minor below 1.0.0, major after)
- [ ] `docs/` and `docs/roadmap.md` updated if the change settles or adds a planned item
- [ ] Tests added or changed; `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` pass
