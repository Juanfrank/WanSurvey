# appconfig

Templates of the App Service settings, with placeholders only. Nothing else in this folder is
kept in the repository (`.gitignore`): copy a template without `.template` and fill it in on
your machine.

| File                                     | For                         |
| ---------------------------------------- | --------------------------- |
| `app-settings.development.template.json` | the development App Service |
| `app-settings.production.template.json`  | the production App Service  |

Each lists **every** setting the app reads. Azure's "Advanced edit" of the application
settings replaces the whole list, so a setting left out of the pasted list is lost.

## Applying

1. Copy the template to `app-settings.<env>.json`, fill in the `<...>` placeholders (secrets as
   `@Microsoft.KeyVault(SecretUri=...)` references) and leave the rest as it is.
2. Azure portal → the App Service → Settings → Environment variables → Advanced edit → paste
   the whole list → Apply. Or: `az webapp config appsettings set --resource-group <rg> --name <app>
--settings @app-settings.<env>.json`.
3. The app checks its settings when it starts and refuses to start, saying what is wrong.

## If something leaks

A secret that was pasted anywhere it should not be (a chat, a commit, a log) is replaced, not
just removed: create a new value in Key Vault, point the setting to it and restart the app. `ENCRYPTION_KEY` is the exception: data already encrypted with the old key stops reading if it
is replaced (see `docs/security.md`, 6.4), so plan its rotation before you do it.

## The Entra redirect URI

`ENTRA_REDIRECT_URI` is `https://<host>/api/auth/entra/callback`, registered exactly like that
(platform _Web_) in the Entra app registration of this app. Register the new URI before
deploying; the former one (`/api/v1/auth/sso/callback`) can stay for a cycle and is retired
afterwards.
