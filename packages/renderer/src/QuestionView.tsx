import {
  formatKey,
  isSpecial,
  own,
  type InterviewSession,
  type TraceEntry,
  type ValidationMessage,
} from '@wansurvey/logic';
import type { AnswerValue, Mode, Question, SpecialKind, StaticText } from '@wansurvey/schema';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DateTimeInput,
  Grid,
  MultiChoice,
  NumericInput,
  Ranking,
  Scale,
  SingleChoice,
  TextInput,
  type ControlProps,
} from './controls.js';
import { messageText, RENDERER_NS } from './i18n.js';
import { keyId } from './text.js';

export interface QuestionViewProps {
  session: InterviewSession;
  entry: TraceEntry;
  mode: Mode;
  lang: string;
  onAnswer(key: string, value: AnswerValue): void;
  onSpecial(key: string, kind: SpecialKind | null): void;
  onConfirm(key: string, ruleId: string): void;
  /** Put the prefilled value back (shown only when it differs from the answer). */
  onRevertPrefill?(key: string): void;
  /** Show "required" errors too (after a failed Next). */
  showAllErrors: boolean;
  /** Respondent modes on small screens get larger targets. */
  touch?: boolean;
  /** Keys shown on the don't know / refused buttons. */
  specialKeys?: { DK: string; RF: string };
}

const INTERVIEWER_MODES: Mode[] = ['CATI', 'CAPI', 'PAPI'];

/** One question or static text, rendered for a mode from a live interview session. */
export function QuestionView(p: QuestionViewProps) {
  const { t } = useTranslation(RENDERER_NS);
  const [localError, setLocalError] = useState<string | null>(null);
  const { session, entry } = p;
  const compiled = session.compiled;
  const node = compiled.nodes[own(compiled.byId, entry.id)!]!;
  const domId = `q-${keyId(entry.key)}`;
  const interviewer = INTERVIEWER_MODES.includes(p.mode);
  const text = session.text(entry.key) ?? '';
  const instruction = interviewer ? session.text(entry.key, 'interviewerInstruction') : null;
  const help = session.text(entry.key, 'helpText');
  const rowLabel = entry.frames.length
    ? entry.frames.map((f) => `${f.name} ${f.row}`).join(' · ')
    : null;

  if (node.kind === 'static') {
    const def = node.def as StaticText;
    return (
      <section
        data-qkey={entry.key}
        tabIndex={-1}
        className="flex flex-col gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        aria-labelledby={`${domId}-text`}
      >
        <p id={`${domId}-text`} className={def.role === 'consent' ? 'text-lg' : 'text-base'}>
          {text}
        </p>
      </section>
    );
  }

  const q = node.def as Question;
  const variant = q.variants?.[p.mode];
  const value = session.getAnswer(entry.key);
  const { options, special } = session.optionsFor(entry.key);
  const validation = session.validate(entry.key);
  const answered = value !== null && !(Array.isArray(value) && value.length === 0) && value !== '';
  const errors = validation.errors.filter(
    (e) => p.showAllErrors || (answered && e.ruleId !== 'required'),
  );
  const warnings = answered ? validation.warnings : [];
  const describedBy = errors.length || warnings.length || localError ? `${domId}-msg` : undefined;

  const heading = (
    <span className="flex flex-col gap-1">
      {interviewer ? (
        <span className="font-mono text-xs text-slate-500">
          {q.name}
          {rowLabel ? ` · ${rowLabel}` : ''}
        </span>
      ) : null}
      <span id={`${domId}-text`} className="text-lg font-medium text-slate-900">
        {text}
      </span>
      {help ? <span className="text-sm text-slate-600">{help}</span> : null}
    </span>
  );

  const props: ControlProps = {
    question: q,
    options,
    value: isSpecial(value) ? null : value,
    onChange: (v) => p.onAnswer(entry.key, v),
    heading,
    ...(describedBy ? { describedBy } : {}),
    showCodes: interviewer,
    touch: !!p.touch,
    ...(variant?.displayAs ? { displayAs: variant.displayAs } : {}),
    lang: p.lang,
  };

  let control;
  switch (q.type) {
    case 'single':
    case 'yesno':
      control = <SingleChoice {...props} />;
      break;
    case 'multi':
      control = <MultiChoice {...props} />;
      break;
    case 'numeric':
      control = <NumericInput {...props} onInvalid={setLocalError} />;
      break;
    case 'text':
      control = <TextInput {...props} />;
      break;
    case 'date':
    case 'time':
    case 'datetime':
      control = <DateTimeInput {...props} />;
      break;
    case 'scale':
      control = <Scale {...props} />;
      break;
    case 'grid':
      control = <Grid {...props} />;
      break;
    case 'ranking':
      control = <Ranking {...props} />;
      break;
  }

  const otherOption = options.find((o) => o.otherSpecify);
  const selected = Array.isArray(value) ? value : [value];
  const otherSelected = otherOption && selected.some((v) => String(v) === String(otherOption.code));
  const otherKey = formatKey(entry.frames, `${q.name}_OTHER`);
  const otherValue = session.getAnswer(otherKey);

  return (
    <section
      data-qkey={entry.key}
      tabIndex={-1}
      className="flex flex-col gap-3 focus:outline-none"
      aria-labelledby={`${domId}-text`}
    >
      {instruction ? (
        <div
          role="note"
          aria-label={t('question.instruction')}
          className="rounded-md border-l-4 border-amber-500 bg-amber-50 px-3 py-2 text-sm font-semibold uppercase tracking-wide text-amber-ink-900"
        >
          {instruction}
        </div>
      ) : null}
      {interviewer && variant?.readOptions ? (
        <p className="text-sm italic text-slate-600">{t('question.readOptions')}</p>
      ) : null}
      <div data-qbody>{control}</div>
      {otherSelected ? (
        <label className="flex flex-col gap-1 sm:max-w-md">
          <span className="text-sm font-medium">{t('question.otherSpecify')}</span>
          <input
            className="rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            value={typeof otherValue === 'string' ? otherValue : ''}
            onChange={(e) => p.onAnswer(otherKey, e.target.value)}
          />
        </label>
      ) : null}
      {special.length ? (
        <div className="flex gap-2">
          {special.map((kind) => {
            const pressed = isSpecial(value) && value.$special === kind;
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={pressed}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm aria-pressed:border-slate-700 aria-pressed:bg-slate-700 aria-pressed:text-slate-50"
                onClick={() => p.onSpecial(entry.key, pressed ? null : kind)}
              >
                {t(`special.${kind}`)}
                <span className="ml-1 text-xs opacity-70">
                  {(p.specialKeys ?? { DK: 'F7', RF: 'F8' })[kind as 'DK' | 'RF']}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {p.onRevertPrefill && session.canRevertToPrefill(entry.key) ? (
        <div>
          <button
            type="button"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            onClick={() => p.onRevertPrefill!(entry.key)}
          >
            {t('question.restorePrefill')}
          </button>
        </div>
      ) : null}
      <Messages
        id={`${domId}-msg`}
        local={localError}
        errors={errors}
        warnings={warnings}
        onConfirm={(ruleId) => p.onConfirm(entry.key, ruleId)}
      />
    </section>
  );
}

function Messages(p: {
  id: string;
  local: string | null;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  onConfirm(ruleId: string): void;
}) {
  const { t } = useTranslation(RENDERER_NS);
  if (!p.local && !p.errors.length && !p.warnings.length) return null;
  return (
    <div id={p.id} className="flex flex-col gap-2">
      {p.local ? <p className="text-sm font-medium text-red-ink-700">{p.local}</p> : null}
      {p.errors.map((e) => (
        <p key={e.ruleId} className="text-sm font-medium text-red-ink-700" data-rule={e.ruleId}>
          {messageText(t, e)}
        </p>
      ))}
      {p.warnings.map((w) => (
        <div
          key={w.ruleId}
          className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-ink-900"
          data-rule={w.ruleId}
        >
          <p>{messageText(t, w)}</p>
          <label className="mt-1 flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-amber-700"
              checked={!!w.confirmed}
              disabled={!!w.confirmed}
              onChange={() => p.onConfirm(w.ruleId)}
            />
            {t('question.confirmWarning')}
          </label>
        </div>
      ))}
    </div>
  );
}
