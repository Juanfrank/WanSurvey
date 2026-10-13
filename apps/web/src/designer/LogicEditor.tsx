import { tryParse } from '@wansurvey/logic';
import {
  DISPOSITIONS,
  type Disposition,
  type EndRule,
  type Question,
  type SkipRule,
  type ValidationRule,
} from '@wansurvey/schema';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ConditionBuilder, unknownNames } from './ConditionBuilder.js';
import {
  FieldError,
  Group,
  Hint,
  inputCls,
  LocalizedField,
  SelectField,
  smallBtn,
} from './fields.js';
import { flatten, isSection, locate, type Draft, type TreeNode } from './tree.js';
import { nodeLabel, nodeName, type VarOption } from './vars.js';
import { dispositionLabel } from '../i18n-messages.js';

/** A free expression (formula, prefill, option filter) with live syntax checking. */
export function ExpressionField({
  label,
  value,
  onChange,
  variables,
  hint,
  extraNames = [],
}: {
  label: string;
  value: string | undefined;
  onChange(v: string | undefined): void;
  variables: VarOption[];
  hint?: string;
  extraNames?: string[];
}) {
  const { t } = useTranslation();
  const id = useId();
  const src = value ?? '';
  const parsed = src.trim() ? tryParse(src) : null;
  const known = useMemo(
    () => new Set([...variables.map((v) => v.name), ...extraNames]),
    [variables, extraNames],
  );
  const unknown = parsed?.ok ? unknownNames(src, known) : [];
  const error =
    parsed && !parsed.ok
      ? t('designer.cond.syntax', {
          message: parsed.error.message,
          at: parsed.error.span.start + 1,
        })
      : unknown.length
        ? t('designer.cond.unknown', { names: unknown.join(', ') })
        : null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <textarea
        id={id}
        rows={2}
        spellCheck={false}
        className={`${inputCls} font-mono`}
        value={src}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint ${id}-err`}
        onChange={(e) => onChange(e.target.value.trim() ? e.target.value : undefined)}
      />
      <Hint id={`${id}-hint`}>{hint ?? t('designer.cond.exprHelp')}</Hint>
      <FieldError id={`${id}-err`}>{error}</FieldError>
    </div>
  );
}

/** Where a skip can go: later items and sections, the end, or (in a roster) the next row. */
export function skipTargets(draft: Draft, fromId: string, lang: string) {
  const list = flatten(draft);
  const i = list.findIndex((x) => x.node.id === fromId);
  const inRoster = (() => {
    let at = locate(draft, fromId);
    while (at && at.parentId) {
      at = locate(draft, at.parentId);
      if (at && !isSection(at.node) && at.node.kind === 'roster') return true;
    }
    return false;
  })();
  const later = list.slice(i + 1).filter((x) => isSection(x.node) || x.node.kind !== 'pagebreak');
  return {
    later,
    inRoster,
    label: (n: TreeNode) => `${nodeName(n)} — ${nodeLabel(n, lang).slice(0, 40)}`,
  };
}

const DISPOSITION_KEYS = Object.keys(DISPOSITIONS) as Disposition[];

export function LogicEditor({
  node,
  draft,
  variables,
  lang,
  onPatch,
}: {
  node: Question;
  draft: Draft;
  variables: VarOption[];
  lang: string;
  onPatch(patch: Partial<Question>): void;
}) {
  const { t } = useTranslation();
  const languages = draft.languages ?? ['en'];
  const targets = skipTargets(draft, node.id, lang);
  const skips = node.skips ?? [];
  const ends = node.endIf ?? [];
  const checks = node.validations ?? [];
  const setSkips = (s: SkipRule[]) => onPatch({ skips: s.length ? s : undefined });
  const setEnds = (e: EndRule[]) => onPatch({ endIf: e.length ? e : undefined });
  const setChecks = (c: ValidationRule[]) => onPatch({ validations: c.length ? c : undefined });
  const nextCheckId = () => {
    const used = new Set(checks.map((c) => c.id));
    let n = checks.length + 1;
    while (used.has(`check${n}`)) n++;
    return `check${n}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <ConditionBuilder
        label={t('designer.logic.showIf')}
        hint={t('designer.logic.showIfHelp')}
        value={node.showIf}
        variables={variables}
        onChange={(showIf) => onPatch({ showIf })}
      />

      <Group title={t('designer.logic.skips')}>
        <Hint>{t('designer.logic.skipsHelp')}</Hint>
        {skips.map((s, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-md border border-slate-200 p-3"
            data-testid="skip-rule"
          >
            <ConditionBuilder
              label={t('designer.logic.skipWhen', { n: i + 1 })}
              value={s.when}
              variables={variables}
              onChange={(when) =>
                setSkips(skips.map((x, j) => (j === i ? { ...x, when: when ?? '' } : x)))
              }
            />
            <SelectField
              label={t('designer.logic.skipTo', { n: i + 1 })}
              value={s.to}
              options={[
                ...targets.later.map((x) => ({ value: x.node.id, label: targets.label(x.node) })),
                ...(targets.inRoster
                  ? [{ value: 'END_ROW', label: t('designer.logic.endRow') }]
                  : []),
                { value: 'END', label: t('designer.logic.end') },
              ]}
              onChange={(to) => setSkips(skips.map((x, j) => (j === i ? { ...x, to } : x)))}
            />
            <div>
              <button
                type="button"
                className={smallBtn}
                onClick={() => setSkips(skips.filter((_, j) => j !== i))}
              >
                {t('designer.logic.removeSkip', { n: i + 1 })}
              </button>
            </div>
          </div>
        ))}
        <div>
          <button
            type="button"
            className={smallBtn}
            onClick={() =>
              setSkips([
                ...skips,
                { when: `${node.name} == 1`, to: targets.later[0]?.node.id ?? 'END' },
              ])
            }
          >
            {t('designer.logic.addSkip')}
          </button>
        </div>
      </Group>

      <Group title={t('designer.logic.checks')}>
        <Hint>{t('designer.logic.checksHelp')}</Hint>
        {checks.map((c, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-md border border-slate-200 p-3"
            data-testid="check-rule"
          >
            <SelectField
              label={t('designer.logic.severity', { n: i + 1 })}
              value={c.severity}
              options={[
                { value: 'error', label: t('designer.logic.error') },
                { value: 'warning', label: t('designer.logic.warning') },
              ]}
              onChange={(severity) =>
                setChecks(checks.map((x, j) => (j === i ? { ...x, severity } : x)))
              }
            />
            <ConditionBuilder
              label={t('designer.logic.checkWhen', { n: i + 1 })}
              value={c.when}
              variables={variables}
              onChange={(when) =>
                setChecks(checks.map((x, j) => (j === i ? { ...x, when: when ?? '' } : x)))
              }
            />
            <LocalizedField
              label={t('designer.logic.message', { n: i + 1 })}
              value={c.message}
              languages={languages}
              onChange={(message) =>
                setChecks(checks.map((x, j) => (j === i ? { ...x, message: message ?? {} } : x)))
              }
            />
            <div>
              <button
                type="button"
                className={smallBtn}
                onClick={() => setChecks(checks.filter((_, j) => j !== i))}
              >
                {t('designer.logic.removeCheck', { n: i + 1 })}
              </button>
            </div>
          </div>
        ))}
        <div>
          <button
            type="button"
            className={smallBtn}
            onClick={() =>
              setChecks([
                ...checks,
                {
                  id: nextCheckId(),
                  severity: 'error',
                  when: `${node.name} == 1`,
                  message: Object.fromEntries(languages.map((l) => [l, ''])),
                },
              ])
            }
          >
            {t('designer.logic.addCheck')}
          </button>
        </div>
      </Group>

      <Group title={t('designer.logic.ends')}>
        <Hint>{t('designer.logic.endsHelp')}</Hint>
        {ends.map((e, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-md border border-slate-200 p-3">
            <ConditionBuilder
              label={t('designer.logic.endWhen', { n: i + 1 })}
              value={e.when}
              variables={variables}
              onChange={(when) =>
                setEnds(ends.map((x, j) => (j === i ? { ...x, when: when ?? '' } : x)))
              }
            />
            <SelectField
              label={t('designer.logic.disposition', { n: i + 1 })}
              value={e.disposition}
              options={DISPOSITION_KEYS.map((d) => ({
                value: d,
                label: `${dispositionLabel(t, d)} (${d})`,
              }))}
              onChange={(disposition) =>
                setEnds(ends.map((x, j) => (j === i ? { ...x, disposition } : x)))
              }
            />
            <div>
              <button
                type="button"
                className={smallBtn}
                onClick={() => setEnds(ends.filter((_, j) => j !== i))}
              >
                {t('designer.logic.removeEnd', { n: i + 1 })}
              </button>
            </div>
          </div>
        ))}
        <div>
          <button
            type="button"
            className={smallBtn}
            onClick={() =>
              setEnds([...ends, { when: `${node.name} == 2`, disposition: 'SCREENED_OUT' }])
            }
          >
            {t('designer.logic.addEnd')}
          </button>
        </div>
      </Group>

      {node.options || node.answerSetId || node.type === 'yesno' ? (
        <ExpressionField
          label={t('designer.logic.optionFilter')}
          hint={t('designer.logic.optionFilterHelp')}
          value={node.optionFilter}
          variables={variables}
          extraNames={['code']}
          onChange={(optionFilter) => onPatch({ optionFilter })}
        />
      ) : null}
      <ExpressionField
        label={t('designer.logic.prefill')}
        hint={t('designer.logic.prefillHelp')}
        value={node.prefill}
        variables={variables}
        onChange={(prefill) => onPatch({ prefill })}
      />
    </div>
  );
}
