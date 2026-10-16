import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FEEDBACK_ITEM_TYPES,
  MAX_FEEDBACK_ITEMS,
  type FeedbackItem,
} from '@wansurvey/schema/feedback';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, inputCls, smallBtn } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button, ErrorText } from '../routes/ui.js';
import { Face } from './Faces.js';
import type { FeedbackPoint } from './FeedbackParts.js';

type ItemType = (typeof FEEDBACK_ITEM_TYPES)[number];

const blank = (type: ItemType, n: number, lang: string): FeedbackItem => ({
  id: `P${n + 2}`,
  type,
  text: { [lang]: '' },
  required: false,
  ...(type === 'text' ? { long: true } : {}),
  ...(type === 'single' || type === 'multi'
    ? {
        options: [
          { code: 1, label: { [lang]: '' } },
          { code: 2, label: { [lang]: '' } },
        ],
      }
    : {}),
});

/**
 * The structure of a Likert point (F2), laid out like a short questionnaire: the Likert is
 * always first and required; after it come up to five questions of the usual kinds, each
 * optionally shown only for some faces, or answered beforehand by a link parameter.
 */
export function FeedbackDesigner({
  projectId,
  point,
  lang,
  onSaved,
}: {
  projectId: string;
  point: FeedbackPoint;
  lang: string;
  onSaved(p: FeedbackPoint): void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [question, setQuestion] = useState(point.question[lang] ?? '');
  const [faces, setFaces] = useState<3 | 5>(point.faces);
  const [items, setItems] = useState<FeedbackItem[]>(point.items ?? []);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api<FeedbackPoint>(`/projects/${projectId}/feedback/${point.id}`, {
        method: 'PATCH',
        body: {
          question: { ...point.question, [lang]: question.trim() || t('feedback.questionDefault') },
          faces,
          items: items.map((it) => ({
            ...it,
            ...(it.param ? {} : { param: undefined }),
          })),
        },
      }),
    onSuccess: async (p) => {
      setStatus(t('feedback.design.saved', { version: p.version }));
      setError(null);
      await qc.invalidateQueries({ queryKey: ['feedback', projectId] });
      onSaved(p);
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const patch = (i: number, v: Partial<FeedbackItem>) =>
    setItems(items.map((it, j) => (j === i ? { ...it, ...v } : it)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...items];
    const [it] = next.splice(i, 1);
    next.splice(i + d, 0, it!);
    setItems(next);
  };
  const full = items.length >= MAX_FEEDBACK_ITEMS;

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="feedback-designer"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-sm text-slate-600">
        {t('feedback.design.help', { max: MAX_FEEDBACK_ITEMS })}
      </p>
      <ol className="flex flex-col gap-3">
        <li
          className="flex flex-col gap-3 rounded-lg border-2 border-indigo-200 bg-indigo-50/40 p-4"
          data-item="LIKERT"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded bg-indigo-600 px-1.5 font-mono text-xs text-on-fill">1</span>
            <span className="font-mono">LIKERT</span>
            <span className="font-semibold">{t('feedback.design.likert')}</span>
            <span className="text-slate-600">· {t('feedback.design.likertFixed')}</span>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('feedback.question')}</span>
            <input
              className={inputCls}
              value={question}
              placeholder={t('feedback.questionDefault')}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          <fieldset className="flex flex-wrap gap-4 text-sm">
            <legend className="mb-1 font-medium">{t('feedback.design.points')}</legend>
            {([3, 5] as const).map((n) => (
              <label key={n} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`faces-${point.id}`}
                  checked={faces === n}
                  onChange={() => setFaces(n)}
                />
                <span className="flex -space-x-1" aria-hidden>
                  {Array.from({ length: n }, (_, i) => (
                    <Face key={i} score={i + 1} faces={n} size={18} />
                  ))}
                </span>
                {t(`feedback.faces${n}`)}
              </label>
            ))}
          </fieldset>
        </li>
        {items.map((it, i) => (
          <ItemEditor
            key={i}
            n={i + 2}
            item={it}
            lang={lang}
            faces={faces}
            first={i === 0}
            last={i === items.length - 1}
            onChange={(v) => patch(i, v)}
            onMove={(d) => move(i, d)}
            onRemove={() => setItems(items.filter((_, j) => j !== i))}
          />
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t('feedback.design.add')}</span>
        {FEEDBACK_ITEM_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className={smallBtn}
            disabled={full}
            onClick={() => setItems([...items, blank(type, items.length, lang)])}
          >
            + {t(`feedback.design.types.${type}`)}
          </button>
        ))}
        <span className="text-xs text-slate-600" data-testid="feedback-count">
          {t('feedback.design.count', { n: items.length, max: MAX_FEEDBACK_ITEMS })}
        </span>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {t('feedback.design.save')}
        </Button>
        <p role="status" className="text-sm text-emerald-ink-800">
          {status}
        </p>
      </div>
    </form>
  );
}

function ItemEditor({
  n,
  item,
  lang,
  faces,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  n: number;
  item: FeedbackItem;
  lang: string;
  faces: 3 | 5;
  first: boolean;
  last: boolean;
  onChange(v: Partial<FeedbackItem>): void;
  onMove(d: -1 | 1): void;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const choice = item.type === 'single' || item.type === 'multi';
  const range = item.showIf ? `${item.showIf.min}-${item.showIf.max}` : '';
  const ranges = [
    ...Array.from({ length: faces - 1 }, (_, k) => `1-${k + 1}`),
    ...Array.from({ length: faces - 1 }, (_, k) => `${k + 2}-${faces}`),
  ];
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4"
      data-item={item.id}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-slate-700 px-1.5 font-mono text-xs text-on-fill">{n}</span>
        <label className="sr-only" htmlFor={`${id}-id`}>
          {t('feedback.design.variable')}
        </label>
        <input
          id={`${id}-id`}
          className={`${inputCls} w-36 font-mono`}
          value={item.id}
          onChange={(e) =>
            onChange({ id: e.target.value.replace(/[^A-Za-z0-9_]/g, '').toUpperCase() })
          }
        />
        <label className="sr-only" htmlFor={`${id}-type`}>
          {t('feedback.design.type')}
        </label>
        <select
          id={`${id}-type`}
          className={`${controlCls} w-auto`}
          value={item.type}
          onChange={(e) => {
            const type = e.target.value as ItemType;
            onChange({
              type,
              ...(type === 'single' || type === 'multi'
                ? { options: item.options?.length ? item.options : blank(type, 0, lang).options }
                : { options: undefined }),
            });
          }}
        >
          {FEEDBACK_ITEM_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`feedback.design.types.${x}`)}
            </option>
          ))}
        </select>
        <span className="ml-auto flex gap-1">
          <button
            type="button"
            className={smallBtn}
            disabled={first}
            aria-label={t('feedback.design.up', { id: item.id })}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={smallBtn}
            disabled={last}
            aria-label={t('feedback.design.down', { id: item.id })}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button type="button" className={smallBtn} onClick={onRemove}>
            {t('feedback.design.remove', { id: item.id })}
          </button>
        </span>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t('feedback.design.text', { id: item.id })}</span>
        <input
          className={inputCls}
          value={item.text[lang] ?? ''}
          onChange={(e) => onChange({ text: { ...item.text, [lang]: e.target.value } })}
        />
      </label>
      {choice ? (
        <fieldset className="flex flex-col gap-1.5 text-sm">
          <legend className="mb-1 font-medium">{t('feedback.design.options')}</legend>
          {(item.options ?? []).map((o, k) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-8 text-right font-mono text-slate-600">{o.code}</span>
              <input
                className={`${inputCls} max-w-sm`}
                aria-label={t('feedback.design.optionLabel', { id: item.id, n: k + 1 })}
                value={o.label[lang] ?? ''}
                onChange={(e) =>
                  onChange({
                    options: item.options!.map((x, j) =>
                      j === k ? { ...x, label: { ...x.label, [lang]: e.target.value } } : x,
                    ),
                  })
                }
              />
              <button
                type="button"
                className={smallBtn}
                disabled={(item.options?.length ?? 0) <= 2}
                onClick={() => onChange({ options: item.options!.filter((_, j) => j !== k) })}
              >
                {t('feedback.design.removeOption')}
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className={smallBtn}
              onClick={() =>
                onChange({
                  options: [
                    ...(item.options ?? []),
                    {
                      code: Math.max(0, ...(item.options ?? []).map((o) => o.code)) + 1,
                      label: { [lang]: '' },
                    },
                  ],
                })
              }
            >
              {t('feedback.design.addOption')}
            </button>
          </div>
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={item.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          {t('feedback.design.required')}
        </label>
        {item.type === 'text' ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!item.long}
              onChange={(e) => onChange({ long: e.target.checked })}
            />
            {t('feedback.design.long')}
          </label>
        ) : null}
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('feedback.design.showIf')}</span>
          <select
            className={`${controlCls} w-auto`}
            value={range}
            onChange={(e) => {
              const [min, max] = e.target.value.split('-').map(Number);
              onChange({ showIf: e.target.value ? { min: min!, max: max! } : undefined });
            }}
          >
            <option value="">{t('feedback.design.always')}</option>
            {ranges.map((r) => {
              const [min, max] = r.split('-');
              return (
                <option key={r} value={r}>
                  {t('feedback.design.faceRange', { min, max })}
                </option>
              );
            })}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('feedback.design.param')}</span>
          <input
            className={`${inputCls} w-36 font-mono`}
            value={item.param ?? ''}
            placeholder="sede"
            onChange={(e) =>
              onChange({
                param: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') || undefined,
              })
            }
          />
        </label>
      </div>
      {item.param ? (
        <p className="text-xs text-slate-600">
          {t('feedback.design.paramHelp', { param: item.param })}
        </p>
      ) : null}
    </li>
  );
}
