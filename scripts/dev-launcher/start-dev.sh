#!/usr/bin/env bash
# WanSurvey for trying it out: starts a disposable SQL Server in Docker, the database and the app.
cd "$(dirname "$0")" && exec node dev-start.mjs "$@"
