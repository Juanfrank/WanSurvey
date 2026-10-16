import {
  DEFAULT_SPECIAL_CODES,
  DISPOSITIONS,
  MODES,
  SPECIAL_KINDS,
  type Disposition,
  type LocalizedText,
  type Quota,
  type Script,
  type SpecialCodes,
} from '@wansurvey/schema';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConditionBuilder } from './ConditionBuilder.js';
import {
  CheckField,
  Group,
  Hint,
  LocalizedField,
  NumberField,
  SelectField,
  smallBtn,
  TextField,
} from './fields.js';
import { PIPE_EXAMPLES } from './i18n.js';
import { OptionsEditor } from './OptionsEditor.js';
import { TranslationsPanel } from './TranslationsPanel.js';
import { flatten, isSection, type Draft } from './tree.js';
import type { VarOption } from './vars.js';
import { dispositionLabel } from '../i18n-messages.js';

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const OUTCOMES = [
  'busy',
  'refusal',
  'callback',
  'voicemail',
  'answered',
  'no_answer',
  'wrong_number',
] as const;

/** Adds empty translations for a new language everywhere a text has the default language. */
function addLanguage(draft: Draft, lang: string): Draft {
  const def = draft.defaultLanguage;
  const json = JSON.stringify(draft, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (
        typeof o[def] === 'string' &&
        !(lang in o) &&
        Object.values(o).every((x) => typeof x === 'string')
      ) {
        return { ...o, [lang]: '' };
      }
    }
    return v;
  });
  const next = JSON.parse(json) as Draft;
  next.languages = [...draft.languages, lang];
  return next;
}

function removeLanguage(draft: Draft, lang: string): Draft {
  const json = JSON.stringify(draft, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (lang in o && Object.values(o).every((x) => typeof x === 'string')) {
        const { [lang]: _drop, ...rest } = o;
        return rest;
      }
    }
    return v;
  });
  const next = JSON.parse(json) as Draft;
  next.languages = draft.languages.filter((l) => l !== lang);
  return next;
}

/** Questionnaire-wide settings: title, languages, special codes, answer sets, scripts, quotas. */
export function SettingsEditor({
  draft,
  variables,
  change,
}: {
  draft: Draft;
  variables: VarOption[];
  change(next: Draft, coalesce?: string): void;
}) {
  const { t } = useTranslation();
  const langs = draft.languages;
  const set = (patch: Partial<Draft>, coalesce?: string) =>
    change({ ...draft, ...patch }, coalesce ? `settings:${coalesce}` : undefined);
  const [newLang, setNewLang] = useState('');
  const [newSet, setNewSet] = useState('');
  const specials: SpecialCodes = draft.settings?.specialCodes ?? DEFAULT_SPECIAL_CODES;
  const settings = draft.settings ?? {
    specialCodes: DEFAULT_SPECIAL_CODES,
    cawiShowSpecialCodes: false,
  };
  const sections = draft.sections.map((s) => s.id);
  const items = flatten(draft)
    .filter((x) => !isSection(x.node))
    .map((x) => x.node.id);
  const empty = (): LocalizedText => Object.fromEntries(langs.map((l) => [l, '']));

  return (
    <div className="flex flex-col gap-8">
      <Group title={t('designer.settings.general')}>
        <LocalizedField
          label={t('designer.title')}
          value={draft.title}
          languages={langs}
          onChange={(title) => set({ title: title ?? {} }, 'title')}
        />
        <TextField
          label={t('designer.settings.id')}
          mono
          value={draft.id}
          hint={t('designer.settings.idHelp')}
          onCommit={(id) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(id) && set({ id })}
        />
      </Group>

      <Group title={t('designer.modes')}>
        <p className="text-sm text-slate-600">{t('designer.settings.modesHelp')}</p>
        <div className="flex flex-wrap gap-2" data-testid="q-modes">
          {MODES.map((m) => {
            const on = (draft.modes ?? MODES).includes(m);
            const only = on && (draft.modes ?? MODES).length === 1;
            return (
              <label
                key={m}
                className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50"
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={only}
                  onChange={(e) =>
                    set({
                      modes: MODES.filter((x) =>
                        x === m ? e.target.checked : (draft.modes ?? MODES).includes(x),
                      ),
                    })
                  }
                />
                <span className="font-semibold">{m}</span>
                <span className="text-slate-600">{t(`designer.modeNames.${m}`)}</span>
              </label>
            );
          })}
        </div>
      </Group>

      <Group title={t('designer.settings.languages')}>
        <ul className="flex flex-wrap gap-2">
          {langs.map((l) => (
            <li
              key={l}
              className="flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
            >
              <span className="font-mono">{l}</span>
              {l === draft.defaultLanguage ? (
                <span className="text-xs text-slate-600">({t('designer.settings.default')})</span>
              ) : (
                <button
                  type="button"
                  className="text-xs underline"
                  aria-label={t('designer.settings.removeLanguage', { lang: l })}
                  onClick={() => {
                    if (window.confirm(t('designer.settings.confirmRemoveLanguage', { lang: l })))
                      change(removeLanguage(draft, l));
                  }}
                >
                  {t('designer.remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const l = newLang.trim();
            if (LANG_RE.test(l) && !langs.includes(l)) {
              change(addLanguage(draft, l));
              setNewLang('');
            }
          }}
        >
          <div className="w-32">
            <TextField
              label={t('designer.settings.addLanguage')}
              mono
              value={newLang}
              placeholder="pt-BR"
              onChange={setNewLang}
              error={
                newLang && !LANG_RE.test(newLang.trim()) ? t('designer.settings.badLanguage') : null
              }
            />
          </div>
          <button type="submit" className={smallBtn}>
            {t('designer.add')}
          </button>
        </form>
        <SelectField
          label={t('designer.settings.defaultLanguage')}
          value={draft.defaultLanguage}
          options={langs.map((l) => ({ value: l, label: l }))}
          onChange={(defaultLanguage) => set({ defaultLanguage })}
        />
      </Group>

      <TranslationsPanel draft={draft} change={change} />

      <Group title={t('designer.settings.specials')}>
        <Hint>{t('designer.settings.specialsHelp')}</Hint>
        {SPECIAL_KINDS.map((k) => (
          <div key={k} className="grid gap-2 sm:grid-cols-[6rem_1fr]">
            <NumberField
              label={t(`designer.settings.special.${k}`)}
              integer
              value={typeof specials[k].code === 'number' ? specials[k].code : undefined}
              onChange={(code) =>
                set({
                  settings: {
                    ...settings,
                    specialCodes: { ...specials, [k]: { ...specials[k], code: code ?? 0 } },
                  },
                })
              }
            />
            <LocalizedField
              label={t('designer.settings.specialLabel', { kind: k })}
              value={specials[k].label}
              languages={langs}
              onChange={(label) =>
                set(
                  {
                    settings: {
                      ...settings,
                      specialCodes: { ...specials, [k]: { ...specials[k], label: label ?? {} } },
                    },
                  },
                  `special-${k}`,
                )
              }
            />
          </div>
        ))}
        <CheckField
          label={t('designer.settings.cawiSpecials')}
          checked={!!settings.cawiShowSpecialCodes}
          onChange={(on) => set({ settings: { ...settings, cawiShowSpecialCodes: on } })}
        />
      </Group>

      <Group title={t('designer.settings.answerSets')}>
        <Hint>{t('designer.settings.answerSetsHelp')}</Hint>
        {Object.entries(draft.answerSets ?? {}).map(([name, options]) => (
          <div key={name} className="rounded-md border border-slate-200 p-3">
            <OptionsEditor
              label={name}
              rows={options}
              languages={langs}
              onChange={(rows) =>
                set({ answerSets: { ...draft.answerSets, [name]: rows } }, `set-${name}`)
              }
            />
            <button
              type="button"
              className={`${smallBtn} mt-2`}
              onClick={() => {
                const { [name]: _drop, ...rest } = draft.answerSets ?? {};
                set({ answerSets: rest });
              }}
            >
              {t('designer.settings.removeSet', { name })}
            </button>
          </div>
        ))}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = newSet.trim();
            if (/^[A-Za-z][A-Za-z0-9_]*$/.test(n) && !(n in (draft.answerSets ?? {}))) {
              set({
                answerSets: {
                  ...draft.answerSets,
                  [n]: [
                    { code: 1, label: empty() },
                    { code: 2, label: empty() },
                  ],
                },
              });
              setNewSet('');
            }
          }}
        >
          <div className="w-48">
            <TextField
              label={t('designer.settings.newSet')}
              mono
              value={newSet}
              onChange={setNewSet}
            />
          </div>
          <button type="submit" className={smallBtn}>
            {t('designer.add')}
          </button>
        </form>
      </Group>

      <Group title={t('designer.settings.scripts')}>
        <Hint>{t('designer.settings.scriptsHelp')}</Hint>
        {(draft.scripts ?? []).map((s, i) => {
          const update = (patch: Partial<Script>, coalesce?: string) =>
            set(
              { scripts: draft.scripts.map((x, j) => (j === i ? { ...x, ...patch } : x)) },
              coalesce ? `script-${i}-${coalesce}` : undefined,
            );
          const a = s.anchor;
          return (
            <div
              key={i}
              className="flex flex-col gap-3 rounded-md border border-slate-200 p-3"
              data-testid="script"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label={t('designer.settings.anchor', { n: i + 1 })}
                  value={a.at}
                  options={(['start', 'end', 'section', 'item', 'callOutcome'] as const).map(
                    (x) => ({
                      value: x,
                      label: t(`designer.settings.anchors.${x}`),
                    }),
                  )}
                  onChange={(at) =>
                    update({
                      anchor:
                        at === 'section'
                          ? { at, sectionId: sections[0] ?? '' }
                          : at === 'item'
                            ? { at, itemId: items[0] ?? '' }
                            : at === 'callOutcome'
                              ? { at, outcome: 'busy' }
                              : { at },
                    })
                  }
                />
                {a.at === 'section' ? (
                  <SelectField
                    label={t('designer.settings.anchorSection')}
                    value={a.sectionId}
                    options={sections.map((x) => ({ value: x, label: x }))}
                    onChange={(sectionId) => update({ anchor: { at: 'section', sectionId } })}
                  />
                ) : null}
                {a.at === 'item' ? (
                  <SelectField
                    label={t('designer.settings.anchorItem')}
                    value={a.itemId}
                    options={items.map((x) => ({ value: x, label: x }))}
                    onChange={(itemId) => update({ anchor: { at: 'item', itemId } })}
                  />
                ) : null}
                {a.at === 'callOutcome' ? (
                  <SelectField
                    label={t('designer.settings.anchorOutcome')}
                    value={a.outcome}
                    options={OUTCOMES.map((x) => ({
                      value: x,
                      label: t(`designer.settings.outcomes.${x}`),
                    }))}
                    onChange={(outcome) => update({ anchor: { at: 'callOutcome', outcome } })}
                  />
                ) : null}
              </div>
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
                        if (modes.length) update({ modes });
                      }}
                    />
                    {m}
                  </label>
                ))}
              </fieldset>
              <LocalizedField
                label={t('designer.settings.scriptBody', { n: i + 1 })}
                value={s.body}
                languages={langs}
                multiline
                hint={t('designer.pipingHelp', PIPE_EXAMPLES)}
                onChange={(body) => update({ body: body ?? {} }, 'body')}
              />
              <div>
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() => set({ scripts: draft.scripts.filter((_, j) => j !== i) })}
                >
                  {t('designer.settings.removeScript', { n: i + 1 })}
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
              set({
                scripts: [
                  ...(draft.scripts ?? []),
                  { id: `script${n}`, anchor: { at: 'start' }, modes: ['CATI'], body: empty() },
                ],
              });
            }}
          >
            {t('designer.settings.addScript')}
          </button>
        </div>
      </Group>

      <Group title={t('designer.settings.quotas')}>
        <Hint>{t('designer.settings.quotasHelp')}</Hint>
        {(draft.quotas ?? []).map((q, i) => {
          const update = (patch: Partial<Quota>, coalesce?: string) =>
            set(
              { quotas: draft.quotas.map((x, j) => (j === i ? { ...x, ...patch } : x)) },
              coalesce ? `quota-${i}-${coalesce}` : undefined,
            );
          return (
            <div key={i} className="flex flex-col gap-3 rounded-md border border-slate-200 p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField
                  label={t('designer.settings.quotaName', { n: i + 1 })}
                  value={q.name}
                  onChange={(name) => update({ name }, 'name')}
                />
                <NumberField
                  label={t('designer.settings.quotaMax', { n: i + 1 })}
                  integer
                  value={q.max}
                  onChange={(max) => update({ max: max ?? 0 })}
                />
                <SelectField
                  label={t('designer.settings.quotaDisposition', { n: i + 1 })}
                  value={q.disposition}
                  options={(Object.keys(DISPOSITIONS) as Disposition[]).map((d) => ({
                    value: d,
                    label: `${dispositionLabel(t, d)} (${d})`,
                  }))}
                  onChange={(disposition) => update({ disposition })}
                />
              </div>
              <ConditionBuilder
                label={t('designer.settings.quotaWhen', { n: i + 1 })}
                value={q.when}
                variables={variables}
                onChange={(when) => update({ when: when ?? '' }, 'when')}
              />
              <div>
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() => set({ quotas: draft.quotas.filter((_, j) => j !== i) })}
                >
                  {t('designer.settings.removeQuota', { n: i + 1 })}
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
              const used = new Set((draft.quotas ?? []).map((q) => q.id));
              let n = (draft.quotas ?? []).length + 1;
              while (used.has(`quota${n}`)) n++;
              const first = variables.find((v) => v.codes);
              set({
                quotas: [
                  ...(draft.quotas ?? []),
                  {
                    id: `quota${n}`,
                    name: t('designer.settings.quotaDefault', { n }),
                    when: first
                      ? `${first.name} == ${JSON.stringify(first.codes![0]!.code)}`
                      : 'true',
                    max: 100,
                    disposition: 'QUOTA_FULL',
                  },
                ],
              });
            }}
          >
            {t('designer.settings.addQuota')}
          </button>
        </div>
      </Group>
    </div>
  );
}
