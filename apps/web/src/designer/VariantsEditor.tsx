import {
  MODES,
  type LocalizedText,
  type Mode,
  type ModeVariant,
  type Variants,
} from '@wansurvey/schema';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckField,
  clean,
  Hint,
  LocalizedField,
  NumberField,
  SelectField,
  smallBtn,
  TextField,
} from './fields.js';

/** Every field of a variant set to undefined: `clean` then drops the variant. */
const emptyVariant = (v: ModeVariant) =>
  Object.fromEntries(Object.keys(v).map((k) => [k, undefined])) as Partial<ModeVariant>;

const DISPLAY_AS = [
  'radio',
  'dropdown',
  'buttons',
  'grid',
  'rowPerPage',
  'slider',
  'checkbox',
] as const;

/**
 * Presentation overrides per mode (spec §4.2). Empty fields inherit the base question; a variant
 * can never change the variable, type or codes.
 */
export function VariantsEditor({
  variants,
  baseText,
  languages,
  isQuestion,
  modes: fielded,
  onChange,
}: {
  variants: Variants | undefined;
  baseText: LocalizedText | undefined;
  languages: string[];
  isQuestion: boolean;
  /** The questionnaire's modes (Q1); wording left for another mode is shown to be removed. */
  modes?: readonly Mode[] | undefined;
  onChange(v: Variants | undefined): void;
}) {
  const { t } = useTranslation();
  const used = fielded?.length ? fielded : MODES;
  const shown = MODES.filter((m) => used.includes(m) || variants?.[m]);
  const [picked, setMode] = useState<Mode>(shown[0] ?? 'CATI');
  const mode = shown.includes(picked) ? picked : (shown[0] ?? 'CATI');
  const v: ModeVariant = variants?.[mode] ?? {};
  const set = (patch: Partial<ModeVariant>) => {
    const next = clean({ ...v, ...patch });
    const all: Variants = { ...(variants ?? {}) };
    if (Object.keys(next).length) all[mode] = next;
    else delete all[mode];
    onChange(Object.keys(all).length ? all : undefined);
  };
  const interviewer = mode !== 'CAWI';
  const count = (m: Mode) => Object.keys(variants?.[m] ?? {}).length;

  return (
    <div className="flex flex-col gap-4">
      <Hint>{t('designer.variants.help')}</Hint>
      <div
        role="radiogroup"
        aria-label={t('designer.variants.mode')}
        className="flex flex-wrap gap-1"
      >
        {shown.map((m) => (
          <label
            key={m}
            className={`cursor-pointer rounded-md border px-3 py-1 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 ${mode === m ? 'border-indigo-600 bg-indigo-50 font-semibold text-indigo-ink-800' : 'border-slate-300'}`}
          >
            <input
              type="radio"
              className="sr-only"
              name="variant-mode"
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            {m}
            {!used.includes(m) ? (
              <span className="ml-1 rounded bg-red-100 px-1 text-xs text-red-ink-900">
                {t('designer.variants.unusedMode')}
              </span>
            ) : null}
            {count(m) ? (
              <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-ink-900">
                {t('designer.variants.overrides', { count: count(m) })}
              </span>
            ) : null}
          </label>
        ))}
      </div>
      {!used.includes(mode) ? (
        <p role="note" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-ink-900">
          {t('designer.variants.unusedModeHelp', { mode })}{' '}
          <button type="button" className={smallBtn} onClick={() => set({ ...emptyVariant(v) })}>
            {t('designer.variants.removeVariant')}
          </button>
        </p>
      ) : null}
      <CheckField
        label={t('designer.variants.visible', { mode })}
        checked={v.visibleInMode !== false}
        onChange={(on) => set({ visibleInMode: on ? undefined : false })}
      />
      <LocalizedField
        label={t('designer.variants.text', { mode })}
        value={v.text}
        languages={languages}
        placeholder={baseText}
        keepEmpty={false}
        multiline
        onChange={(text) => set({ text })}
        hint={t('designer.variants.inherits')}
      />
      {interviewer ? (
        <LocalizedField
          label={t('designer.variants.instruction')}
          value={v.interviewerInstruction}
          languages={languages}
          keepEmpty={false}
          onChange={(interviewerInstruction) => set({ interviewerInstruction })}
        />
      ) : null}
      <LocalizedField
        label={t('designer.variants.help_text')}
        value={v.helpText}
        languages={languages}
        keepEmpty={false}
        onChange={(helpText) => set({ helpText })}
      />
      {isQuestion ? (
        <>
          {mode === 'CATI' || mode === 'CAPI' ? (
            <CheckField
              label={t('designer.variants.readOptions')}
              checked={!!v.readOptions}
              onChange={(on) => set({ readOptions: on || undefined })}
            />
          ) : null}
          <SelectField
            label={t('designer.variants.displayAs')}
            value={v.displayAs ?? ''}
            options={[
              { value: '', label: t('designer.variants.default') },
              ...DISPLAY_AS.map((d) => ({ value: d, label: t(`designer.display.${d}`) })),
            ]}
            onChange={(d) => set({ displayAs: (d || undefined) as ModeVariant['displayAs'] })}
          />
          {mode === 'CAPI' ? (
            <TextField
              label={t('designer.variants.showcard')}
              value={v.showcard}
              onChange={(showcard) => set({ showcard: showcard || undefined })}
            />
          ) : null}
          {mode === 'PAPI' ? (
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label={t('designer.variants.columns')}
                integer
                value={v.printLayout?.columns}
                onChange={(columns) => {
                  const pl = clean({ ...(v.printLayout ?? {}), columns });
                  set({ printLayout: Object.keys(pl).length ? pl : undefined });
                }}
              />
              <NumberField
                label={t('designer.variants.boxes')}
                integer
                value={v.printLayout?.boxes}
                onChange={(boxes) => {
                  const pl = clean({ ...(v.printLayout ?? {}), boxes });
                  set({ printLayout: Object.keys(pl).length ? pl : undefined });
                }}
              />
            </div>
          ) : null}
        </>
      ) : null}
      {count(mode) ? (
        <div>
          <button
            type="button"
            className={smallBtn}
            onClick={() => set(Object.fromEntries(Object.keys(v).map((k) => [k, undefined])))}
          >
            {t('designer.variants.clear', { mode })}
          </button>
        </div>
      ) : null}
    </div>
  );
}
