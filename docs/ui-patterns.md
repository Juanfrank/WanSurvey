# Screen patterns: less scrolling, less crowding

Lists open with their rows, not with blocks of controls above them. Filters wait behind a
button, row actions behind "⋯", the actions on ticked rows appear only when something is ticked,
and forms that create something open in a side panel. The building blocks are in
`apps/web/src/routes/` and exported from `routes/ui.tsx`; each file starts with a comment on how
to use it. The **case list** (`apps/web/src/cases/CasesTab.tsx`) is the reference screen that uses
them all. Translation keys in the examples below that the case list does not use are illustrative.

| Need                                                    | Use               | File                    |
| ------------------------------------------------------- | ----------------- | ----------------------- |
| The page title, beside the account menu                 | `PageHeader`      | `routes/PageHeader.tsx` |
| First-level tabs on one line, the seldom used in "More" | `OverflowTabList` | `routes/tabs.tsx`       |
| Search, filters, the filters that are on, list tools    | `FilterBar`       | `routes/FilterBar.tsx`  |
| Actions on the ticked rows                              | `BulkBar`         | `routes/BulkBar.tsx`    |
| A form that creates or edits something of the list      | `Drawer`          | `routes/Drawer.tsx`     |
| Secondary actions of a row, or seldom used tools        | `MoreMenu`        | `routes/MoreMenu.tsx`   |

## The page header

The top row of every signed-in page holds the page's title on the left and the account menu on
the right (`AppLayout`). A page puts its title there with `PageHeader`, which renders its one
`h1`; nothing else goes above the page's content.

```tsx
// A page of its own (Users, Home, an administration page): the title and its main button.
<PageHeader
  title={t('admin.webhooks')}
  actions={canManage ? <Button onClick={() => setCreating(true)}>{t('admin.webhooksPage.add')}</Button> : null}
/>

// A page inside something: the breadcrumb is the title, the project name (the h1) in bold.
<PageHeader
  parents={[<Link key="p" to="/projects">{t('designer.projects')}</Link>]}
  title={<Link to="/projects/$projectId" params={{ projectId }}>{project.name}</Link>}
  current={tabLabel(tab)}
/>
```

The two sit side by side in a flex row, so the account never covers the title (it used to be laid
over the page's first line). A page that does not use `PageHeader` still works: the row then has
only the account. The work screens (interview, review, My device, print) use it too: the
breadcrumb's last step is the case, as the `h1` marked `aria-current="page"`, and what used to
be a header card (timers, language, saved) is one slim line under the row. `noPrint` keeps the
header out of a printout.

The breadcrumb keeps one line, and its last step (the `h1`, e.g. "Case HH0031") is not cut
while anything else can give way: the steps before it are cut short first ("Household Su…"),
then folded from the first one ("Projects") into a single "…" whose title names them; a name
beside the title (the respondent) is cut short only after that. Do not pass a `title` to a
parent link: `PageHeader` names a cut or folded step itself. A work screen under ~1024 px uses
the phone pattern ("‹ Case HH0031"). A page with a back link, a title and one subtitle (print
forms, print slips) puts "← Back" in `icon`, the subtitle in `aside` with `min-w-0 flex-1
basis-0 truncate` and its text in `title`, and its button in a bar under the row.

## Long lists in blocks, side panes as a floating button

- `useShowMore(total)` and `ShowMoreButton` (`routes/ShowMore.tsx`): the first 20 rows and a
  "Show 20 more (35 left)" button, for lists that are not paged by the server.
- `SideDrawer` with `float="Callbacks (2)"`: folded, the pane is a floating button at the bottom
  right (not a rail), so the content keeps its width; it opens above the button and can still be
  kept open as a column (the calls screen's "My callbacks").

## Tabs on one line

`OverflowTabList` replaces a wrapping `Tabs.List` of first-level tabs. Mark the seldom used tabs
`rarely: true` (on a project: People and Project settings): they live in "More ▾" unless open. The
last tabs that do not fit go there too; the open tab is always in the row. A phone folds the
same way (a row that only scrolled sideways hid its last tab at the edge). `sub` gives second-level pills (the questionnaire designer's topics, in the
row of Design / Settings), and an item's `badge` (a count) shows after its label in the row.

```tsx
<OverflowTabList
  label={t('cases.tabs.label')}
  value={current}
  onSelect={(v) => setTab(v as ProjectTab)}
  items={tabs.map((x) => ({
    value: x,
    label: tabLabel(x),
    rarely: x === 'people' || x === 'settings',
  }))}
/>
```

## A list: FilterBar, table, BulkBar

```tsx
<FilterBar
  search={{ value: q, onChange: setQ, label: t('team.search') }}
  active={[
    ...(status ? [{ id: 'status', label: t('team.status'), value: t(`team.s.${status}`), onRemove: () => setStatus('') }] : []),
  ]}
  count={t('team.count', { count: rows.length })}
  actions={
    <>
      <Button size="sm" onClick={() => setInviting(true)}>{t('team.invite.open')}</Button>
      <MoreMenu label={t('team.moreTools')} entries={tools}>
        <span aria-hidden="true">⋯</span> {t('ui.more')}
      </MoreMenu>
    </>
  }
>
  {/* The filters, as they were: label + control. They show in the floating panel. */}
  <label className="flex flex-col gap-1 text-sm">
    <span className="font-medium">{t('team.status')}</span>
    <select className={controlCls} value={status} onChange={(e) => setStatus(e.target.value)}>…</select>
  </label>
</FilterBar>

<table>…</table>
<nav>…pagination…</nav>
<p className="text-xs text-slate-600">{/* footnotes of the table, e.g. hidden personal data */}</p>

<BulkBar
  count={selected.size}
  label={t('cases.list.selectedRegion', { count: selected.size })}
  onClear={() => setSelected(new Set())}
>
  <span className="font-semibold">{t('cases.list.selected', { count: selected.size })}</span>
  <Button size="sm" onClick={assign}>{t('cases.list.assign')}</Button>
  <button type="button" className={smallBtn} onClick={unassign}>{t('cases.list.unassign')}</button>
</BulkBar>
```

- **Search**: always in view; its label is the placeholder and its accessible name.
- **A filter with a default** other than "any" (the review queue's Status, "Waiting for
  review") goes in the panel like the rest; its chip shows only while it differs from the
  default, and removing the chip puts the default back.
- **Filters**: the controls keep their state where it was (the screen's own `useState`, the
  address); the bar only shows and hides them. Each filter that is on gets a chip with a
  "Remove filter: Status Assigned" button; "Filters · 2" says how many are on. The panel floats
  over the list (it does not push it), takes the focus when it opens, closes with Escape (focus
  back to the button), with the button and with a click outside; under 640 px it is full width.
- **Figures above a list** that filter it (the case states) are a strip of pills: the name and
  the number; the definition goes in `title`.
- **Rows** stay on one line (`whitespace-nowrap` cells; the table scrolls sideways).
- **Notes about the table** (hidden personal data, how a pool works) go under it, small.
- **BulkBar**: only while rows are ticked; fixed at the bottom between the side panel and the
  edge; a region named "3 cases selected"; it keeps its height free after the list so the last
  row and the pagination stay reachable. Put it after the pagination. Actions that work on the
  whole list without a selection (assign every free case by the rules, share them out) go in the
  toolbar's `MoreMenu`.

## Row actions: MoreMenu

```tsx
<td className="text-right">
  <MoreMenu label={t('team.actions', { name: m.name })} entries={entriesFor(m)} />
</td>
```

A bare "⋯" named after the row ("Actions for Ana Pérez"). Entries are `MenuEntry` items
(`designer/Menu.tsx`, the same menu as the questionnaire and user actions): arrows, Home/End and
the first letter move, Enter picks, Escape closes; picking or Escape returns the focus to "⋯".
With visible text (`children`), start `label` with that text.

## Create forms: Drawer

```tsx
{creating ? (
  <Drawer
    title={t('analysis.exports.new')}
    onClose={() => setCreating(false)}
    footer={<Button type="submit" form={formId}>{t('analysis.exports.run')}</Button>}
  >
    <form id={formId} onSubmit={…}>…</form>
  </Drawer>
) : null}
```

The modal `Dialog` laid out against the right edge (full screen on a phone): focus trapped,
Escape and ✕ close it, focus returns to the button that opened it, named by its title. Use it
instead of a form card above the list or a form at the bottom of the page. `wide` makes it up to
48rem wide instead of 28rem, for a form with a table (the sample import's column mapping).

## Long explanations: FoldedHelp

A paragraph of grey help that is always on screen goes in `FoldedHelp` (`designer/fields.tsx`):
one line with an (i) in front; a click unfolds the whole text. The text stays in the page, so an
`id` on it still works for `aria-describedby`. Do not put it inside a `<label>` (it is a
disclosure); important warnings stay as they are.

```tsx
<FoldedHelp id="settings-expiry-help" className="max-w-prose">
  {t('cases.settings.expiryHelp')}
</FoldedHelp>
```

Inside `FoldHintsContext` (the designer sets it), every `Hint` longer than 90 characters folds
the same way.

## Long help: an ⓘ

A page's introduction, or the help of a card, goes behind an ⓘ beside its title instead of a
paragraph above the content: `InfoTip` (`cases/samplingControls.tsx`) with `text`. Beside a
page title, pass it as `PageHeader`'s `aside` with `align="start"`. Notices that matter (read
only, a warning) stay in view, small.

```tsx
<PageHeader
  title={t('team.title')}
  aside={<InfoTip id="team-intro" term={t('team.title')} text={t('team.intro')} align="start" />}
/>
```

## Status messages: useNote

A message shown after an action ("Settings saved.", "11 personal links made.", an error) is kept
as its translation key and values, not as finished text, and written out when the screen is
drawn: if the user changes the language, the message follows. `useNote` (`i18n-messages.ts`) is
`useState` for it; `text` is already in the current language.

```tsx
const [message, setMessage] = useNote();
// …
onSuccess: (r) => setMessage({ key: 'cawi.links.made', vars: { count: r.links } }),
onError: (e) => setMessage({ error: e }), // written out with localiseError
setMessage(null); // none
// A value that is itself a note is written out too; `parts` joins sentences.
setMessage({ key: 'review.screen.done', vars: { status: { key: `interview.status.${to}` } } });
setMessage({ parts: [{ key: 'cases.list.assigned', vars: { count } }, { key: 'cases.list.skipped', vars: { count: skipped } }] });
// …
<p role="status" aria-live="polite" className="empty:hidden">{message}</p>
```

A callback that reports to its parent (`onDone`) passes a `Note`, not a string. Do not keep
`t(…)` in state (`useState(t('…'))`, `setMessage(t('…'))`): it freezes the language of the moment.
The end-to-end tests run in English and switch to Spanish only for each screenshot, so a frozen
message shows up in English in the pictures.

## End-to-end tests

`e2e/helpers.ts` has:

- `gotoTab(page, 'Project settings')`: opens a project tab from the row or from "More".
  Use it for every first-level project tab that may be under "More" (People, Project settings),
  and in loops over tabs.
- `designerTab(page, 'Versions')`: opens a topic of the questionnaire designer (under Design or
  Settings) from the row or from its "More".
- `openFilters(page)` / `closeFilters(page)`: open the Filters panel before using a filter
  control, and close it before clicking rows it may cover.

Chips: `page.getByRole('button', { name: 'Remove filter: Team North' })`; the bar:
`page.getByRole('region', { name: '3 cases selected' })`.
