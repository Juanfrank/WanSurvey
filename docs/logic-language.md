# Logic language reference

Questionnaire logic is written once and runs the same way in every place it is evaluated: in the browser during a live interview, offline on CAPI tablets, and on the server when an interview is submitted. Most questionnaires are built in the visual rule builder (slice 4), which compiles rules into this language. Power users can also edit expressions directly.

Expressions are parsed to an AST and interpreted. Nothing is ever `eval`'d.

## Values

`number`, `string` (`"…"` or `'…'`), `boolean` (`true`/`false`), dates as ISO strings (`"2026-10-12"`), codes (numbers or strings), arrays (multi-choice answers, roster columns) and `null` (unanswered).

Don't know and Refused are stored as `{"$special":"DK"}` and `{"$special":"RF"}`. Test them with `isDK(Q)` and `isRefused(Q)`.

## Operators

Lowest precedence first:

| Precedence | Operators                                                                        |
| ---------- | -------------------------------------------------------------------------------- |
| 1          | `or` (alias `\|\|`)                                                              |
| 2          | `and` (alias `&&`)                                                               |
| 3          | `not` (alias `!`)                                                                |
| 4          | `== != < <= > >=` (aliases `=`, `<>`), `in (…)`, `not in (…)`, `between a and b` |
| 5          | `+ -` (`+` also joins two strings)                                               |
| 6          | `* / %`                                                                          |
| 7          | unary `-`                                                                        |
| 8          | `^` (right-associative)                                                          |
| 9          | `Q[n]`, `R[n].X`, `case.field`                                                   |

Comparisons cannot be chained (`1 < Q < 5` is an error); use `Q between 1 and 5`.

## Null semantics

- Any comparison involving an unanswered or DK/RF value is **false**. This includes `!=`, `in` and `between`.
- Arithmetic involving null returns null. Dividing by zero returns null.
- In a condition, null counts as false. `not null` is true.
- `Q == null` and `Q != null` test whether Q is unanswered. This is the only exception to the rules above; `answered(Q)` is the clearer form.
- An expression never throws. Anything it cannot compute becomes null.

## Scope

| Name                                                         | Meaning                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `Q5_AGE`                                                     | A question or computed variable defined **earlier** in the questionnaire |
| `case.region`                                                | Sample data of the case                                                  |
| `interviewer.firstName`, `respondent.firstName`, `project.x` | Context profiles                                                         |
| `mode`                                                       | `"CATI"`, `"CAPI"`, `"CAWI"` or `"PAPI"`                                 |
| `index`                                                      | Current roster row (1-based), available inside rosters                   |
| `HH[2].AGE`                                                  | A field of one roster row                                                |
| `HH.AGE`                                                     | A roster column, as an array                                             |
| `code`                                                       | Inside `optionFilter`: the option being tested                           |

## Functions

| Function                       | Result                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `answered(Q)`                  | Q has an answer (DK and RF count as answered)                                                                                |
| `count(Q, code)`               | How many elements of a multi-choice answer or roster column equal `code`                                                     |
| `sum(…)`, `min(…)`, `max(…)`   | Calculated over numeric arguments; arrays are flattened and unanswered values ignored. Null if there is nothing to calculate |
| `length(x)`                    | Length of a text, or the number of selected codes or rows                                                                    |
| `contains(Q, code)`            | The multi-choice answer includes `code`, or the text includes the substring                                                  |
| `age(dob, ref?)`               | Completed years; `ref` defaults to today                                                                                     |
| `datediff(a, b, unit?)`        | `b − a` in `"days"` (default), `"weeks"`, `"months"`, `"years"`, `"hours"` or `"minutes"`                                    |
| `today()`                      | Today's date (ISO)                                                                                                           |
| `date(s)`                      | The ISO date, or null when invalid                                                                                           |
| `label(Q)`                     | Label of the selected code in the active language                                                                            |
| `isDK(Q)`, `isRefused(Q)`      | Q holds that special answer                                                                                                  |
| `rosterCount(R)`               | Number of rows in roster R                                                                                                   |
| `any(R, expr)`, `all(R, expr)` | `expr` evaluated in each row of R; `all` is true for an empty roster                                                         |
| `round(x, n?)`, `abs(x)`       | Arithmetic helpers                                                                                                           |

## Where logic attaches

| Rule                | Field                                                                                                 | Example                       |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------- |
| Display condition   | `showIf` (on any item, block, roster or section)                                                      | `Q2 in (1, 2)`                |
| Skip                | `skips: [{ when, to }]`. `to` is a later item id, `END_ROW` or `END`                                  | `Q5 < 18` → `SEC_D`           |
| Hard check          | `validations: [{ severity: "error", when, message }]`                                                 | `Q10 > Q9`                    |
| Soft check          | `validations: [{ severity: "warning", … }]`; the interviewer confirms, and the confirmation is logged | `Q5 > 95`                     |
| Computed variable   | `{ kind: "computed", formula }`                                                                       | `round(Q20 / (Q19/100)^2, 1)` |
| Option filter       | `optionFilter`                                                                                        | `code != Q3`                  |
| Roster count        | `count: { type: "expression", expr }`                                                                 | `Q4`                          |
| End interview       | `endIf: [{ when, disposition }]`                                                                      | `Q1 == 2` → `SCREENED_OUT`    |
| Quota               | `quotas: [{ when, max }]`                                                                             | `AGE_GROUP == 3`, max 150     |
| Assignment on entry | `prefill`                                                                                             | `case.region`                 |

## Piping

Pipes are written in question text, instructions, option labels, messages and scripts:

```
{{Q3_NAME}}  {{case.city}}  {{interviewer.firstName}}  {{respondent.firstName}}
{{today | date:"long"}}  {{Q7 | label}}  {{roster.HH_MEMBERS[i].NAME}}
{{#if Q2 == 1}}your husband{{else}}your wife{{/if}}
```

A pipe resolves at render time from the current answers, the case, the interviewer and the project. In preview, an unresolved pipe shows as `[Q3_NAME]`. If a pipe names an unknown variable, or a variable that is only asked later, publishing is blocked.

## Static analysis at publish

Publishing is blocked by any of these errors:

- Syntax errors
- Unknown variables or functions
- Wrong function arity
- Type mismatches
- Forward references
- Skips that go backwards, target an unknown item, or cross a roster boundary
- Unreachable items
- Cycles between computed variables
- Missing or malformed pipes
- Duplicate ids or variables, or reserved names
- Duplicate codes, or codes that clash with the special codes
- Unknown answer sets, empty option lists and invalid ranges or patterns

These only produce warnings: comparing against a code that is not in the answer set, missing translations, an item hidden in every mode, and a computed type that differs from the declared one.
