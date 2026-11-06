# ADR 0002: People registry, no-contact list and exclusion by channel

- **Status:** accepted; implemented in `0.1.0-alpha.20` (see the scope below)
- **Date:** 2026-11-06
- **Deciders:** product owner
- **Scope:** the user stories HU-02, HU-03 and HU-08 of the first round with the area: nobody is contacted who should not be, per channel, and a person is recognised across studies and channels.

## Context

Today a person exists only as a **case of a project**, with contacts (phone, e-mail, address) that are plain values under the organisation's row-level security. The only memory across projects is `duplicate_elsewhere` at load (a count by project name) and the plan's cross-case checks. Nothing remembers that someone asked not to be called, was surveyed last month by another channel, or took part in the 2020 wave.

What the area asked for: a registry that grows over time (CRM-like), an exclusion period per channel, a no-contact list per contact and channel with a permanence, a "do not call" outcome in the call, and loading the history since 2020 and the people already marked "not interested".

## Decisions

### 1. A person is identified by their contacts, not by a new person record

There is no `people` table with its own id. A person is whatever shares a **normalised contact value**: a phone in E.164 (`normalisePhone`, as contacts already are) or an e-mail in lower case. This is what the data the area has actually carries (the 2020 history has phones and e-mails, not a common person id), it needs no merge or split tooling, and it is what the load already compares. The cost is that a person with two numbers is two registry keys; the case-level outcomes below write **every** contact of the case, which covers the common situation. Linking keys into one person is left for when the area has an identifier to link on.

### 2. Two tables, both per organisation and under row-level security

- `no_contact`: one row per (organisation, kind, value): `channels` (a JSON list of modes, or null for every channel), `reason` (`do_not_contact`, `not_interested`, `complaint`, `deceased`, `other`), `source` (`call`, `manual`, `import`), `expires_at` (null: permanent), who and when, and `lifted_at` / `lifted_by`. Lifting keeps the row (the history of who asked and who lifted it), and a value has at most one active row; adding again updates it.
- `participations`: one row per (organisation, kind, value, channel, date) with the result and the project's name as text: "who took part in what". The system writes it when a case's interview is submitted (every contact of the case); the history since 2020 is loaded into it (`source = 'history'`). It stores contact values and a project name only, never answers.

### 3. Rules are parameters of the project

`contactRules` in the project's settings: `exclusion.days` (a person with a participation in the last N days is not loaded or called again; null: off), `exclusion.channels` (which channels count, so a phone survey can ignore the web one), and `noContact.defaultDays` (how long a "do not contact" entry from a call lasts; null: permanent). Exclusion by result (for example a refusal excluding for longer than a completed interview) is **not** in this round; it needs the area's table of results and periods.

### 4. Where the rules apply

- **At load** (cleaning stage): a row whose phone or e-mail is on the active no-contact list for any of the project's channels, or has a participation inside the exclusion window, is reported (`no_contact`, `recent_participation`) and no case is made for it, as with the cross-case checks. The file keeps its place in the history.
- **In the call queue**: a case with a phone on the active no-contact list for `CATI` is not served (`no_contact` in the queue's reasons). This covers entries added after the case was loaded.
- **In web invitations** (e-mail, SMS): an address or number on the list for `CAWI` is not sent to; the invitation is marked as skipped.
- **At download to a device (CAPI)**: a case with a contact on the list for `CAPI` is refused (`NO_CONTACT`). A case already on a device cannot be stopped offline; that stays open.

### 5. The "do not contact" outcome

A new call outcome `do_not_contact` (AAPOR 2.11, refusal, final) adds every phone and e-mail of the case to the no-contact list for all channels, with the project's default permanence, and finishes the case. It is allowed on an answered call that is being closed as well. It is audited (`registry.no_contact_added`, source `call`).

### 6. The registry page and the loads

Administration → People registry (permissions `registry.read` and `registry.manage`): search a phone or e-mail to see its participations and its no-contact entry, add or lift an entry, and load two files (CSV or the first sheet of a spreadsheet, mapped by the person): the **no-contact list** (value, reason, channels, expiry) and the **history** (value, channel, date, result, project). The history's real column layout is still the area's to give; the loader maps by column name and reports what it cannot read.

## Consequences

- Phone and e-mail values are stored as in `contacts` (no new class of data), and are reached through the same erasure: a data-subject erasure removes the person's participations (by contact value) but **keeps** their no-contact entries: an erased person must still not be contacted, and the list holds nothing but the value and the terms.
- Cleaning at load gets two more checks; the duplicates **against earlier loads** that HU-02 asked for are the participations and the contacts of other projects, already compared by value.
- Left out on purpose: merging keys into one person, exclusion by result, a calendar of validity for the exclusion criteria, face-to-face enforcement, and the sources (Zoho, SGC).
