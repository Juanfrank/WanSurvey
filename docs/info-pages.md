# Informative pages: About, Privacy, Terms

WanSurvey follows the institution's common schema for these three public pages, so that every
application publishes them with the same structure. The reference specification is the document
"17 · Esquema común de páginas informativas" (WanKPI). This file says how WanSurvey applies it.

| Element                     | In WanSurvey                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes (public, no session) | `/about`, `/privacy`, `/terms`                                                                                                                                                                                                                                                                                                                            |
| Contract (types)            | `packages/schema/src/info-pages.ts`: `InfoSection` (`Section`), `InfoPage` (`Page`), `AboutFacts`, `TechnicalFacts`. `Section` has `links` (internal routes only)                                                                                                                                                                                         |
| Content                     | pure functions `aboutPage`, `privacyPage`, `termsPage` `(facts, es) → Page` in `apps/web/src/about/content.ts`                                                                                                                                                                                                                                            |
| Public facts                | `GET /api/v1/public/about` → `AboutFacts` (no build, no environment, no paths)                                                                                                                                                                                                                                                                            |
| Technical data              | `GET /api/v1/system/technical` (needs a session) → `{ build, environment, node }`; the web adds the `technical` section only with a session                                                                                                                                                                                                               |
| Renderer                    | `InfoShell` / `InfoLayout` in `apps/web/src/routes/InfoPages.tsx`, shared by the three pages                                                                                                                                                                                                                                                              |
| Contract test               | `apps/web/test/info-pages.test.ts` (ids, order, languages, conditional `rights`, no empty sections, internal links, contact fallback, date); `apps/api/test/mssql/about-http.test.ts` (nothing operational in the public answer; the protected one needs a session); `apps/web/e2e/about-privacy.spec.ts` (axe, keyboard, back, with and without session) |

## Settings (all optional, the same names in every application)

| Variable          | Feeds                                        | If missing                                                          |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `ORG_NAME`        | `organisation` (section `who`)               | "This installation is run by an organisation"                       |
| `PRIVACY_CONTACT` | `privacyContact` (`contact`, privacy, terms) | "Write to your organisation's administrator"                        |
| `APP_AUTHOR`      | `author` (`rights`)                          | the section is left out (there is no project constant in WanSurvey) |
| `APP_HOLDER`      | `holder` (`rights`)                          | the holder is not shown                                             |
| `APP_BUILD`       | `technical.build` (signed-in people only)    | the version                                                         |

## About, in order

`what`, `who`, `version`, `rights` (only with an author or a holder), `access` (how people get in and
which optional services are on: only those that are), `contact`, `documents` (internal links to
Privacy and Terms), `technical` (build, mode and Node: only with a session, last).

Privacy ids: `controller, who, respondents, staff, purposes, cookies, recipients, retention, rights,
security, transfers, changes`. Terms ids: `who, use, confidentiality, prohibited, records,
incidents, consequences, duration, version`. All kebab-case, unique, and the same in both languages.

## Rules kept

Optional sections without content are left out whole; ids are stable; services that are off are not
claimed (the text of About and Privacy is built from the facts); no external links; no licence,
changelog or roadmap; nothing operational in the public part; no claim of accessibility conformance
while there is no audit. People with a session who can work see the pages inside the application's
frame; the others on a page of their own, with a language selector and a Back link (it goes back, or
to the start if they came straight to the page).

## Writing conventions (§5.1 of the schema)

Section titles: capital on the first word only, not numbered, no final full stop or colon; one form
per page (Privacy: questions; Terms: nouns; About keeps the reference's mix of `what`/`who` questions
and nouns). Intros are one or two sentences ending in a full stop; Privacy's closes with "Última
actualización: {date}." Paragraphs end in a full stop, or a colon when they introduce a list, and the
phrase that introduces a list agrees with its bullets ("…tenga en cuenta estas reglas:" + "No
comparta…"). Bullets are full sentences ending in a full stop, or "Label: value" with none. Always
_usted_ or the impersonal. Inner references by name in «…» (English “…”), never "section 5". Document
names as in the footer: «Acerca de», «Política de privacidad», «Términos de uso» (English "About",
"Privacy policy", "Terms of use"). One contact formula ("Escriba a {contact}." / "Escriba al
administrador de su organización."). English spelling: British (_organisation_, _authorised_) across
the whole application. No sentence is assembled from translated fragments: optional services are
said in whole sentences or bullets of the `access` section. `apps/web/test/info-pages.test.ts`
checks what can be checked automatically (titles, intros, paragraphs, bullets, references by number,
the closing date).

## For the legal area before publishing

Ownership or transfer of the rights over the code (author as a person or as an institution); the
disclaimer in `rights`; the controller and the legal basis (`who`, privacy); the official contact and
its response commitments; accessibility statements (none are made); the full text of the Terms of use;
whether to show the author's name; visibility of licences and third-party notices; the applicable
data-protection law.
