# Step 2: apply the migrations

With the database made (step 1), the application makes its tables, schemas (`rls`, `bi`), security
policy and grants itself, with the **owner** login and the application's own user:

```
DATABASE_ADMIN_URL="mssql://<OwnerLogin>:<OwnerPassword>@<server>:1433/<DbName>?trustServerCertificate=true"
DATABASE_URL="mssql://wansurvey_app:<AppPassword>@<server>:1433/<DbName>?trustServerCertificate=true"
node dist/db/migrate.js        # in the API image; from the repository: pnpm --filter @wansurvey/api db:migrate
```

`DATABASE_URL` (the application) must use the user `wansurvey_app` and the password of step 1: the
migration sets it again on that user. Keep `DATABASE_ADMIN_URL` for deployments only.
