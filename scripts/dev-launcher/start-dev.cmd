@echo off
rem WanSurvey for trying it out: starts a disposable SQL Server in Docker, the database and the app.
cd /d "%~dp0"
node dev-start.mjs %*
