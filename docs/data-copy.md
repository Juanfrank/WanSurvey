# Copying the data from PostgreSQL to SQL Server (retired)

WanSurvey ran on PostgreSQL until it moved to SQL Server (`docs/roadmap.md`). There was no production data to
carry over, so the copy tool was never used for a real move and was removed together with the PostgreSQL code.

It lives in the git history, last present at commit `3484e04` (`apps/api/src/db/copy/`, `scripts/make-copy-source.mjs`,
`scripts/engine-parity.sh`): it read both schemas, copied every table in foreign-key order as JSON through
`OPENJSON`, and verified counts, id fingerprints and sample rows. It copied 1.83 million rows (1 GB) in 253 s
(about 7,200 rows/s). If a PostgreSQL database of an old version ever has to be loaded, start from that commit
and from the PostgreSQL migrations at the same point of the history.
