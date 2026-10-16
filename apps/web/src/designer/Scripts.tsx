import type { LocalizedText, Script } from '@wansurvey/schema';
import { useTranslation } from 'react-i18next';
import { Group, Hint, LocalizedField, SelectField, smallBtn } from './fields.js';
import { PIPE_EXAMPLES } from './i18n.js';
import type { Draft } from './tree.js';

export const OUTCOMES = [
  'busy',
  'refusal',
  'callback',
  'voicemail',
  'answered',
  'no_answer',
  'wrong_number',
] as const;

type Anchor = Script['anchor'];
/** Anchors edited in the questionnaire settings; item and section scripts live in their editors. */
const GLOBAL_AT = ['start', 'end', 'callOutcome'] as const;

const isGlobal = (a: Anchor) => (GLOBAL_AT as readonly string[]).includes(a.at);

/** The scripts a place owns: the global ones, or those of one item or section. */
export function scriptsFor(
  draft: Draft,
  place: 'global' | { itemId: string } | { sectionId: string },
) {
  return (draft.scripts ?? [])
    .map((s, i) => ({ s, i }))
    .filter(({ s }) =>
      place === 'global'
        ? isGlobal(s.anchor)
        : 'itemId' in place
          ? s.anchor.at === 'item' && s.anchor.itemId === place.itemId
          : s.anchor.at === 'section' && s.anchor.sectionId === place.sectionId,
    );
}

/**
 * Interviewer scripts for one place. In the settings: the start, the end and call outcomes.
 * In a question's or section's editor: the scripts read there, which follow the item.
 */
export function ScriptsEditor({
  draft,
  change,
  place,
  title,
  hint,
}: {
  draft: Draft;
  change(next: Draft, coalesce?: string): void;
  place: 'global' | { itemId: string } | { sectionId: string };
  title: string;
  hint: string;
}) {
  const { t } = useTranslation();
  const langs = draft.languages;
  const empty = (): LocalizedText => Object.fromEntries(langs.map((l) => [l, '']));
  const mine = scriptsFor(draft, place);
  const update = (i: number, patch: Partial<Script>, coalesce?: string) =>
    change(
      { ...draft, scripts: draft.scripts.map((x, j) => (j === i ? { ...x, ...patch } : x)) },
      coalesce ? `script-${draft.scripts[i]!.id}-${coalesce}` : undefined,
    );
  const newAnchor: Anchor =
    place === 'global'
      ? { at: 'start' }
      : 'itemId' in place
        ? { at: 'item', itemId: place.itemId }
        : { at: 'section', sectionId: place.sectionId };

  return (
    <Group title={title}>
      <Hint>{hint}</Hint>
      {mine.map(({ s, i }, n) => {
        const a = s.anchor;
        return (
          <div
            key={s.id}
            className="flex flex-col gap-3 rounded-md border border-slate-200 p-3"
            data-testid="script"
          >
            {place === 'global' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label={t('designer.settings.anchor', { n: n + 1 })}
                  value={a.at}
                  options={GLOBAL_AT.map((x) => ({
                    value: x,
                    label: t(`designer.settings.anchors.${x}`),
                  }))}
                  onChange={(at) =>
                    update(i, {
                      anchor:
                        at === 'callOutcome'
                          ? { at, outcome: 'busy' }
                          : { at: at as (typeof GLOBAL_AT)[number] & ('start' | 'end') },
                    })
                  }
                />
                {a.at === 'callOutcome' ? (
                  <SelectField
                    label={t('designer.settings.anchorOutcome')}
                    value={a.outcome}
                    options={OUTCOMES.map((x) => ({
                      value: x,
                      label: t(`designer.settings.outcomes.${x}`),
                    }))}
                    onChange={(outcome) => update(i, { anchor: { at: 'callOutcome', outcome } })}
                  />
                ) : null}
              </div>
            ) : null}
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="mb-1 font-medium text-slate-700">
                {t('designer.settings.scriptModes')}
              </legend>
              {(['CATI', 'CAPI', 'PAPI'] as const).map((m) => (
                <label key={m} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={s.modes.includes(m)}
                    onChange={(e) => {
                      const modes = e.target.checked
                        ? [...s.modes, m]
                        : s.modes.filter((x) => x !== m);
                      if (modes.length) update(i, { modes });
                    }}
                  />
                  {m}
                </label>
              ))}
            </fieldset>
            <LocalizedField
              label={t('designer.settings.scriptBody', { n: n + 1 })}
              value={s.body}
              languages={langs}
              multiline
              hint={t('designer.pipingHelp', PIPE_EXAMPLES)}
              onChange={(body) => update(i, { body: body ?? {} }, 'body')}
            />
            <div>
              <button
                type="button"
                className={smallBtn}
                onClick={() =>
                  change({ ...draft, scripts: draft.scripts.filter((_, j) => j !== i) })
                }
              >
                {t('designer.settings.removeScript', { n: n + 1 })}
              </button>
            </div>
          </div>
        );
      })}
      <div>
        <button
          type="button"
          className={smallBtn}
          onClick={() => {
            const used = new Set((draft.scripts ?? []).map((s) => s.id));
            let n = (draft.scripts ?? []).length + 1;
            while (used.has(`script${n}`)) n++;
            change({
              ...draft,
              scripts: [
                ...(draft.scripts ?? []),
                { id: `script${n}`, anchor: newAnchor, modes: ['CATI', 'CAPI'], body: empty() },
              ],
            });
          }}
        >
          {t('designer.settings.addScript')}
        </button>
      </div>
    </Group>
  );
}
