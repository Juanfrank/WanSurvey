# Accessibility

Target: WCAG 2.2 AA on every screen, including the respondent's web survey (spec §11). Interviewer and data-entry screens are also built to be faster by keyboard than by mouse.

## How it is checked

| Check                                                                                                                                                                                                                                                                                                             | Where                                         | Runs             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------- |
| axe-core on every renderer component, every question type and mode                                                                                                                                                                                                                                                | `packages/renderer/test`                      | `pnpm test` (CI) |
| axe-core in the browser (with colour contrast) on the pages below                                                                                                                                                                                                                                                 | `apps/web/e2e/*.spec.ts` (`expectAccessible`) | `pnpm e2e` (CI)  |
| A whole household interview by keyboard only (CATI)                                                                                                                                                                                                                                                               | `e2e/preview.spec.ts`                         | CI               |
| A telephone shift by keyboard only, with callbacks                                                                                                                                                                                                                                                                | `e2e/cati.spec.ts`                            | CI               |
| Designing a questionnaire by keyboard                                                                                                                                                                                                                                                                             | `e2e/designer.spec.ts`                        | CI               |
| A web respondent by keyboard only, on a phone                                                                                                                                                                                                                                                                     | `e2e/hardening.spec.ts`                       | CI               |
| Touch targets of at least 44 × 44 px on the respondent's phone screen                                                                                                                                                                                                                                             | `e2e/hardening.spec.ts`                       | CI               |
| 200% zoom (a 640 px layout): no sideways scrolling on the respondent and project pages                                                                                                                                                                                                                            | `e2e/hardening.spec.ts`                       | CI               |
| Configurable don't know / refused keys                                                                                                                                                                                                                                                                            | `packages/renderer/test/runner.test.tsx`      | CI               |
| Every question type as a respondent (1280 and 320 px) and an interviewer sees it: axe before and after answering and with errors shown, no sideways scrolling at 320 px                                                                                                                                           | `e2e/a11y-renderer.spec.ts`                   | CI               |
| Chosen scale points readable on their colour (4.5:1), ranking focus kept, `aria-invalid`                                                                                                                                                                                                                          | `packages/renderer/test`                      | CI               |
| Every dialog that opens in any browser test is checked with axe while it is open (colour contrast included), once per dialog: an automatic fixture, `e2e/fixtures.ts`                                                                                                                                             | all `e2e/*.spec.ts`                           | CI               |
| Dialogs no other flow opens (API keys and their one-time key, webhooks, their secret and deliveries, bulk withdrawal, logic check); the review's reject and correct dialogs and the interview's shortcuts and note dialogs are looked at inside their own flows, closed with Escape, focus returned to the opener | `e2e/a11y-overlays.spec.ts`                   | CI               |
| Side panels and menus in each state: the application's side panel (open, compact, over the content, on a phone), the account menu, the designer's outline drawer and the calls screen's callbacks drawer (pinned, rail, over the content)                                                                         | `e2e/a11y-panels.spec.ts`                     | CI               |

Pages checked with axe in the browser: sign-in and the waiting page, the designer (logic, publish dialog, version comparison, translations, comments, library, routing map), the preview, sample import (mapping, report, duplicates), the case list, assignments, project settings, the interviewer screen and an interview's history, the CATI workspace, the device page offline, the web survey on a phone (invitation and preview), the wave funnel, paper forms with QR codes, double-entry differences, the review queue and screen, the dashboard, metrics, results with a crosstab, the shared summary, exports, and a case with its personal data section.

## Results (slice 13 audit, revised after the 2026 audit)

| WCAG 2.2 criterion                      | Result | Notes                                                                                                                                                                           |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1.1 Non-text content                  | Pass   | Charts are tables with bars (figures written out); the day chart has a text alternative and a table                                                                             |
| 1.3.1 Info and relationships            | Pass   | Option groups are `fieldset`/`legend`; tables have headers; headings in order                                                                                                   |
| 1.3.5 Identify input purpose            | Pass   | Web respondents' e-mail and phone questions carry `autocomplete` (`email`, `tel`); off on interviewers' devices                                                                 |
| 1.4.3 Contrast                          | Pass   | axe colour-contrast on every page above; a web survey style whose derived shades fall under 4.5:1 (3:1 for marks) is refused by Logo and style (the API does not check it yet)  |
| 1.4.4 Resize text / 1.4.10 Reflow       | Pass   | 320 px and 200% zoom without sideways scrolling; every wide table scrolls inside its own box                                                                                    |
| 1.4.11 Non-text contrast                | Pass   | Focus outline 2 px in `--color-focus` (3:1 or more in the light and dark themes, white on the navy panel; a project colour that would fade is replaced); bars against slate-100 |
| 2.1.1 Keyboard                          | Pass   | Every flow above by keyboard; no keyboard traps (dialogs close with Esc)                                                                                                        |
| 2.3.3 Animation from interactions       | Pass   | `prefers-reduced-motion` turns off transitions and animations everywhere                                                                                                        |
| 2.4.3 Focus order / 2.4.7 Focus visible | Pass   | Focus moves to the new question's first control on every step (to the opening text when a web page starts with one); always visible on controls                                 |
| 2.4.11 Focus not obscured               | Pass   | No sticky overlays over the focused control                                                                                                                                     |
| 2.5.8 Target size (minimum)             | Pass   | 44 × 44 px on the respondent's and CAPI screens (stricter than AA's 24 px)                                                                                                      |
| 2.4.2 Page titled                       | Pass   | Every staff page is titled after its heading and open tab; respondents' pages after the survey                                                                                  |
| 3.1.2 Language of parts                 | Pass   | Questions carry the questionnaire's `lang`                                                                                                                                      |
| 3.3.1 Error identification              | Pass   | Errors next to the question, fields marked `aria-invalid`; feedback forms move the focus to the first one                                                                       |
| 3.3.7 Redundant entry                   | Pass   | Prefilled values and resume after a reload                                                                                                                                      |
| 4.1.2 Name, role, value                 | Pass   | Native controls; ARIA only for tabs, dialogs, live regions and progress                                                                                                         |
| 4.1.3 Status messages                   | Pass   | Saving state, sync, exports, ranking moves and the live dashboard update in polite live regions, which stay in the page so changes are announced                                |

## Keyboard map (interviewer screens)

| Key                      | Action                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Digits                   | Choose the option with that code (multi-digit codes typed quickly)                                                                        |
| Space                    | Toggle the focused checkbox                                                                                                               |
| Enter                    | Next question                                                                                                                             |
| Shift+Enter, Alt+←       | Previous question                                                                                                                         |
| F7 / F8                  | Don't know / Refused — **configurable per project** (F1–F10 except F5)                                                                    |
| Ctrl+M / Ctrl+G / Ctrl+P | Note, go to a section, pause — **letters configurable per project**; Ctrl+N, Ctrl+T and Ctrl+W are refused because the browser keeps them |
| Esc                      | Close a dialog                                                                                                                            |
| ?                        | Show the shortcuts                                                                                                                        |

## Organisation accent

An organisation can pick an accent from a fixed palette (Administration, Organisation, Appearance). The tokens of each accent are generated for the light and the dark theme, and `checkAccent` (`packages/schema/src/theme.ts`) verifies the 4.5:1 text contrast on every surface; a unit test runs it on the whole palette, and the API refuses an accent that fails. A person's own theme choice always wins over the organisation default, and the respondent pages keep the neutral look.

## Manual test plan (before each major release)

The automated checks above do not hear what a screen reader says nor see a page at 200 %. Before
each major release one person runs this plan and writes the result (pass, or the problem with
its screen and step) in the release notes. Each script runs in **NVDA + Firefox** (Windows) and
**VoiceOver + Safari** (macOS; the respondent part also with VoiceOver on an iPhone), with the
interface in Spanish and then in English.

| Script                  | Steps (by keyboard only, listening)                                                                                                           | Listen for                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web respondent          | Open a personal link of a survey with an introduction, a logo with a description and an e-mail question; answer two pages, go back once, send | The logo's description; the introduction read before the first question; the survey's language throughout, footer included; e-mail offered by autofill; "Respuestas guardadas" announced once |
| Invite a person         | Administration → Users: invite a person with a role, then open the row's "Actions" menu                                                       | Column headers read with each cell; the dialog's title on opening; the result announced; focus back on the button that opened it                                                              |
| Change a permission     | Administration → Roles: change one permission of a role and save                                                                              | Each checkbox read with its role and its permission (row and column headers); the save announced                                                                                              |
| Filter the activity log | Administration → Activity log: filter by person and by date, open an entry                                                                    | The number of results announced after filtering; the entry's details reachable and read in order                                                                                              |
| An interview (CAPI)     | Open an assigned case, answer three questions with digits, record a note, pause                                                               | Question text, then options with their codes; errors read when Next is refused; the note dialog's title                                                                                       |

**Zoom at 200 %** (or a 640 px window): besides the respondent and project pages that
`e2e/hardening.spec.ts` checks, look at Users, Roles, Activity log and Organisation, and the web
survey style in project settings. Nothing may need sideways scrolling of the page (a wide table
may scroll inside its own box) and no menu, dialog or sticky bar may cover the focused control.

## Known limits

- Screen-reader testing in CI is done with the axe rules and the accessibility tree in Playwright, not with a screen reader; the manual plan above covers NVDA and VoiceOver before each major release.
- At 200 % zoom `e2e/hardening.spec.ts` checks Activity log and Organisation. Users (726 px wide in a 640 px window) and Roles and permissions (903 px) still scroll sideways and are checked by hand (manual plan above) until that is fixed.
- The case map (Leaflet) is decorative for keyboard users: every case on it is also in the list, with its address.
- "Go to question" moves by section, then to the question within it; a search by variable or text is in phase 2.
