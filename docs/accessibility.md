# Accessibility

Target: WCAG 2.2 AA on every screen, including the respondent's web survey (spec §11). Interviewer and data-entry screens are also built to be faster by keyboard than by mouse.

## How it is checked

| Check                                                                                  | Where                                         | Runs             |
| -------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------- |
| axe-core on every renderer component, every question type and mode                     | `packages/renderer/test`                      | `pnpm test` (CI) |
| axe-core in the browser (with colour contrast) on the pages below                      | `apps/web/e2e/*.spec.ts` (`expectAccessible`) | `pnpm e2e` (CI)  |
| A whole household interview by keyboard only (CATI)                                    | `e2e/preview.spec.ts`                         | CI               |
| A telephone shift by keyboard only, with callbacks                                     | `e2e/cati.spec.ts`                            | CI               |
| Designing a questionnaire by keyboard                                                  | `e2e/designer.spec.ts`                        | CI               |
| A web respondent by keyboard only, on a phone                                          | `e2e/hardening.spec.ts`                       | CI               |
| Touch targets of at least 44 × 44 px on the respondent's phone screen                  | `e2e/hardening.spec.ts`                       | CI               |
| 200% zoom (a 640 px layout): no sideways scrolling on the respondent and project pages | `e2e/hardening.spec.ts`                       | CI               |
| Configurable don't know / refused keys                                                 | `packages/renderer/test/runner.test.tsx`      | CI               |

Pages checked with axe in the browser: sign-in and the waiting page, the designer (logic, publish dialog, version comparison, translations, comments, library, routing map), the preview, sample import (mapping, report, duplicates), the case list, assignments, project settings, the interviewer screen and an interview's history, the CATI workspace, the device page offline, the web survey on a phone (invitation and preview), the wave funnel, paper forms with QR codes, double-entry differences, the review queue and screen, the dashboard, metrics, results with a crosstab, the shared summary, exports, and a case with its personal data section.

## Results (slice 13 audit)

| WCAG 2.2 criterion                      | Result | Notes                                                                                               |
| --------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| 1.1.1 Non-text content                  | Pass   | Charts are tables with bars (figures written out); the day chart has a text alternative and a table |
| 1.3.1 Info and relationships            | Pass   | Option groups are `fieldset`/`legend`; tables have headers; headings in order                       |
| 1.4.3 Contrast                          | Pass   | axe colour-contrast on every page above                                                             |
| 1.4.4 Resize text / 1.4.10 Reflow       | Pass   | 200% zoom without sideways scrolling; wide tables scroll inside their own box                       |
| 1.4.11 Non-text contrast                | Pass   | Focus ring 2 px indigo-600; bars against slate-100                                                  |
| 2.1.1 Keyboard                          | Pass   | Every flow above by keyboard; no keyboard traps (dialogs close with Esc)                            |
| 2.3.3 Animation from interactions       | Pass   | `prefers-reduced-motion` turns off transitions and animations everywhere                            |
| 2.4.3 Focus order / 2.4.7 Focus visible | Pass   | Focus moves to the new question's first control on every step; always visible                       |
| 2.4.11 Focus not obscured               | Pass   | No sticky overlays over the focused control                                                         |
| 2.5.8 Target size (minimum)             | Pass   | 44 × 44 px on the respondent's and CAPI screens (stricter than AA's 24 px)                          |
| 3.3.1 Error identification              | Pass   | Errors next to the question, announced in a live region; cleared answers announced too              |
| 3.3.7 Redundant entry                   | Pass   | Prefilled values and resume after a reload                                                          |
| 4.1.2 Name, role, value                 | Pass   | Native controls; ARIA only for tabs, dialogs, live regions and progress                             |
| 4.1.3 Status messages                   | Pass   | Saving state, sync, exports and the live dashboard update in polite live regions                    |

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

## Known limits

- Screen-reader testing was done with the axe rules and the accessibility tree in Playwright, not with every screen reader and browser pair; a manual pass with NVDA and VoiceOver is recommended before each major release.
- The case map (Leaflet) is decorative for keyboard users: every case on it is also in the list, with its address.
- "Go to question" moves by section, then to the question within it; a search by variable or text is in phase 2.
