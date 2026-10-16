import './sampling-i18n.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { planChecks, planSizes, type PlanCheck } from '@wansurvey/logic';
import { DISPOSITIONS } from '@wansurvey/schema';
import {
  NONPROBABILITY_METHODS,
  PROBABILITY_METHODS,
  SPECIAL_METHODS,
  type SamplingPlanInput,
} from '@wansurvey/schema/sampling';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuestionnaireScope, useScoped } from './scope.js';
import { api } from '../api.js';
import { controlCls, inputCls, smallBtn } from '../designer/fields.js';
import { dispositionLabel, localiseError } from '../i18n-messages.js';
import { dateTime } from '../format.js';
import { Button, Card, ErrorText } from '../routes/ui.js';
import { ImportTab } from './ImportTab.js';
import { CrossChecks } from './CrossChecks.js';
import { useSampleFields } from './hooks.js';

type Plan = SamplingPlanInput;
type Family = Plan['design']['family'];
type Method = Plan['design']['method'];

interface Sampling {
  plan: Plan;
  status: 'draft' | 'selected';
  seed: string | null;
  selectedAt: string | null;
  result: unknown;
  checks: PlanCheck[];
  frame: {
    units: number;
    eligible: number;
    excluded: number;
    strata: number;
    smallestStratum: number | null;
    clusters: number;
    byStratum: { stratum: string; units: number }[];
    sources: { label: string; units: number }[];
    /** Units left out by the cross-case checks. */
    crossChecked?: number;
  };
  cases: Record<string, number>;
  reservesLeft: number;
  unitsLeft: number;
  fields: string[];
}

interface Preview {
  errors: PlanCheck[];
  selected: number;
  reserves: number;
  strata: { stratum: string; population: number; selected: number; reserve: number }[];
  warnings: string[];
  prob: { min: number; max: number } | null;
}

const METHODS: Record<Family, readonly Method[]> = {
  probability: PROBABILITY_METHODS,
  nonprobability: NONPROBABILITY_METHODS,
  special: SPECIAL_METHODS,
  census: ['census'],
};

const sevCls: Record<PlanCheck['severity'], string> = {
  error: 'border-red-200 bg-red-50 text-red-ink-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-ink-900',
  info: 'border-sky-200 bg-sky-50 text-sky-ink-900',
};
const sevIcon: Record<PlanCheck['severity'], string> = { error: '✕', warning: '!', info: 'i' };

function Layer({
  title,
  help,
  children,
  testId,
}: {
  title: string;
  help: string;
  children: ReactNode;
  testId: string;
}) {
  const id = useId();
  return (
    <Card>
      <section aria-labelledby={id} className="flex flex-col gap-4" data-testid={testId}>
        <div>
          <h2 id={id} className="text-lg font-semibold">
            {title}
          </h2>
          <p className="text-sm text-slate-600">{help}</p>
        </div>
        {children}
      </section>
    </Card>
  );
}

/**
 * An (i) next to a term: on hover, focus or tap it explains the term and the usual standard
 * (`cases.sampling.tips.<id>`). The explanation is the button's description for screen readers.
 */
export function InfoTip({ id, term }: { id: string; term: string }) {
  const { t } = useTranslation();
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const std = t(`cases.sampling.tips.${id}.std`, { defaultValue: '' });
  return (
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-slate-400 font-serif text-[10px] font-bold italic leading-none text-slate-600 hover:border-indigo-600 hover:text-indigo-ink-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        aria-label={t('cases.sampling.tip.label', { term })}
        aria-describedby={tipId}
        aria-expanded={open}
        data-tip={id}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        i
      </button>
      <span
        role="tooltip"
        id={tipId}
        hidden={!open}
        className="absolute left-1/2 top-full z-30 mt-1.5 w-72 max-w-[80vw] -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-3 text-left text-xs font-normal not-italic leading-relaxed text-slate-700 shadow-lg"
      >
        <span className="block">{t(`cases.sampling.tips.${id}.text`)}</span>
        {std ? (
          <span className="mt-1.5 block">
            <strong className="font-semibold text-slate-900">
              {t('cases.sampling.tip.standard')}
            </strong>{' '}
            {std}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** A choice among cards (radio group), each with a short explanation. */
function Choice<T extends string>({
  legend,
  tip,
  value,
  options,
  onChange,
  disabled,
  columns = 2,
}: {
  legend: string;
  tip?: string;
  value: T;
  options: { value: T; label: string; hint?: string; tip?: string }[];
  onChange(v: T): void;
  disabled?: boolean;
  columns?: number;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-2 text-sm font-medium text-slate-700">
        {legend}
        {tip ? <InfoTip id={tip} term={legend} /> : null}
      </legend>
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(${columns > 2 ? 12 : 16}rem, 1fr))`,
        }}
      >
        {options.map((o) => (
          <div key={o.value} className="relative">
            <label className="flex h-full cursor-pointer gap-2 rounded-lg border border-slate-200 bg-white p-3 pr-7 text-sm has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50">
              <input
                type="radio"
                name={name}
                className="mt-0.5"
                checked={value === o.value}
                onChange={() => onChange(o.value)}
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                {o.hint ? <span className="block text-xs text-slate-600">{o.hint}</span> : null}
              </span>
            </label>
            {o.tip ? (
              <span className="absolute right-2 top-2.5">
                <InfoTip id={o.tip} term={o.label} />
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function YesNo({
  label,
  tip,
  value,
  onChange,
  disabled,
}: {
  label: string;
  tip?: string;
  value: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const name = useId();
  return (
    <fieldset disabled={disabled} className="flex flex-wrap items-center gap-3 text-sm">
      <legend className="mb-1 w-full font-medium text-slate-700">
        {label}
        {tip ? <InfoTip id={tip} term={label} /> : null}
      </legend>
      {[true, false].map((v) => (
        <label key={String(v)} className="flex items-center gap-1.5">
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
          {v ? t('cases.sampling.yes') : t('cases.sampling.no')}
        </label>
      ))}
    </fieldset>
  );
}

function Num({
  label,
  tip,
  value,
  onChange,
  step = 'any',
  min,
  max,
  percent,
  disabled,
}: {
  label: string;
  tip?: string;
  value: number | null;
  onChange(v: number | null): void;
  step?: string;
  min?: number;
  max?: number;
  /** Shown and typed as a percentage (0.05 ↔ 5). */
  percent?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const shown =
    value === null ? '' : percent ? String(Math.round(value * 10000) / 100) : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex items-center">
        <label htmlFor={id} className="font-medium text-slate-700">
          {label}
        </label>
        {tip ? <InfoTip id={tip} term={label} /> : null}
      </span>
      <span className="relative flex items-center">
        <input
          id={id}
          className={`${controlCls} w-full tabular-nums ${percent ? 'pr-7' : ''}`}
          inputMode="decimal"
          value={text}
          disabled={disabled}
          step={step}
          {...(min !== undefined ? { min } : {})}
          {...(max !== undefined ? { max } : {})}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value.replace(',', '.'));
            if (e.target.value.trim() === '') onChange(null);
            else if (Number.isFinite(n)) onChange(percent ? n / 100 : n);
          }}
        />
        {percent ? (
          <span aria-hidden className="pointer-events-none absolute right-2.5 text-slate-500">
            %
          </span>
        ) : null}
      </span>
    </div>
  );
}

function VarSelect({
  label,
  tip,
  value,
  fields,
  onChange,
  disabled,
}: {
  label: string;
  tip?: string;
  value: string;
  fields: string[];
  onChange(v: string): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex items-center">
        <label htmlFor={id} className="font-medium text-slate-700">
          {label}
        </label>
        {tip ? <InfoTip id={tip} term={label} /> : null}
      </span>
      <select
        id={id}
        className={`${controlCls} w-auto`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('cases.sampling.none')}</option>
        {fields.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The sampling selector (S1): layer 1 the source of the units (and the frame), layer 2 the
 * selection design (and control quotas), layer 3 the size, eligibility, checks and preview;
 * then the selection makes the cases, with reserves and substitutes by rule.
 */
export function SamplingTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const scoped = useScoped();
  const questionnaire = useQuestionnaireScope();
  const sampleFields = useSampleFields(projectId);
  const data = useQuery({
    queryKey: ['sampling', projectId, questionnaire],
    queryFn: () => api<Sampling>(scoped(`/projects/${projectId}/sampling`)),
  });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [importing, setImporting] = useState(false);
  const [sourceLabel, setSourceLabel] = useState('');
  useEffect(() => {
    if (data.data && !plan) setPlan(data.data.plan);
  }, [data.data, plan]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['sampling', projectId] });
    await qc.invalidateQueries({ queryKey: ['cases', projectId] });
  };
  const save = useMutation({
    mutationFn: (p: Plan) =>
      api(scoped(`/projects/${projectId}/sampling`), { method: 'PUT', body: p }),
    onSuccess: async () => {
      setMessage(t('cases.sampling.saved'));
      setError(null);
      await refresh();
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const runPreview = useMutation({
    mutationFn: async (p: Plan) => {
      await api(scoped(`/projects/${projectId}/sampling`), { method: 'PUT', body: p });
      return api<Preview>(scoped(`/projects/${projectId}/sampling/preview`), { method: 'POST' });
    },
    onSuccess: async (r) => {
      setPreview(r);
      setError(null);
      await refresh();
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const select = useMutation({
    mutationFn: async (p: Plan) => {
      await api(scoped(`/projects/${projectId}/sampling`), { method: 'PUT', body: p });
      return api<{ created: number }>(scoped(`/projects/${projectId}/sampling/select`), {
        method: 'POST',
      });
    },
    onSuccess: async () => {
      setPreview(null);
      setError(null);
      await refresh();
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const clear = useMutation({
    mutationFn: () => api(scoped(`/projects/${projectId}/sampling/frame`), { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => setError(localiseError(t, e)),
  });

  const d = data.data;
  if (!d || !plan) return <p aria-busy="true">…</p>;
  const locked = d.status === 'selected';
  const set = (patch: Partial<Plan>) => setPlan({ ...plan, ...patch });
  const setSource = (patch: Partial<Plan['source']>) =>
    set({ source: { ...plan.source, ...patch } });
  const setDesign = (patch: Partial<Plan['design']>) =>
    set({ design: { ...plan.design, ...patch } });
  const setSize = (patch: Partial<Plan['size']>) => set({ size: { ...plan.size, ...patch } });
  const sizes = planSizes(plan, d.frame.eligible || undefined);
  const checks = planChecks(plan, d.frame);
  const probability = plan.design.family === 'probability';
  const census = plan.design.family === 'census';
  const usesFrame = plan.source.kind !== 'field' && plan.source.frameAvailable;
  const pct = (v: number) =>
    new Intl.NumberFormat(i18n.language, { maximumSignificantDigits: 3 }).format(v);
  const fmt = (v: number) => new Intl.NumberFormat(i18n.language).format(v);
  const m = plan.design.method;

  return (
    <div className="flex flex-col gap-6" data-testid="sampling">
      <p className="text-sm text-slate-700">{t('cases.sampling.intro')}</p>

      {/* Layer 1 */}
      <Layer
        title={t('cases.sampling.layer1')}
        help={t('cases.sampling.layer1Help')}
        testId="layer-1"
      >
        <Choice
          legend={t('cases.sampling.layer1')}
          tip="source"
          value={plan.source.kind}
          disabled={locked}
          options={(['frame', 'registry', 'field', 'combined'] as const).map((k) => ({
            value: k,
            label: t(`cases.sampling.sources.${k}`),
            hint: t(`cases.sampling.sourceHints.${k}`),
          }))}
          onChange={(kind) =>
            setSource({
              kind,
              ...(kind === 'field' ? { frameAvailable: false } : { frameAvailable: true }),
            })
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1 text-sm">
            <span className="flex items-center">
              <label htmlFor="sp-unit" className="font-medium text-slate-700">
                {t('cases.sampling.unit')}
              </label>
              <InfoTip id="unit" term={t('cases.sampling.unit')} />
            </span>
            <input
              id="sp-unit"
              className={inputCls}
              value={plan.source.unit}
              placeholder={t('cases.sampling.unitPlaceholder')}
              disabled={locked}
              onChange={(e) => setSource({ unit: e.target.value })}
            />
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{t('cases.sampling.description')}</span>
            <textarea
              className={inputCls}
              rows={2}
              value={plan.source.description}
              disabled={locked}
              onChange={(e) => setSource({ description: e.target.value })}
            />
          </label>
        </div>
        <div className="grid gap-4 rounded-lg bg-slate-50 p-3 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <YesNo
              label={t('cases.sampling.populationKnown')}
              tip="populationKnown"
              value={plan.source.populationKnown}
              disabled={locked}
              onChange={(populationKnown) => setSource({ populationKnown })}
            />
            {plan.source.populationKnown ? (
              <Num
                label={t('cases.sampling.populationSize')}
                tip="populationKnown"
                value={plan.source.populationSize}
                step="1"
                min={1}
                disabled={locked}
                onChange={(n) => setSource({ populationSize: n ? Math.round(n) : null })}
              />
            ) : null}
          </div>
          <YesNo
            label={t('cases.sampling.frameAvailable')}
            tip="frameAvailable"
            value={plan.source.frameAvailable}
            disabled={locked || plan.source.kind === 'field'}
            onChange={(frameAvailable) => setSource({ frameAvailable })}
          />
          <p className="text-xs text-slate-600 md:col-span-2">{t('cases.sampling.decision1')}</p>
        </div>
        {usesFrame ? (
          <div className="flex flex-col gap-3" data-testid="frame">
            <h3 className="font-semibold">
              {t('cases.sampling.frame')} ·{' '}
              <span data-testid="frame-units">
                {t('cases.sampling.frameUnits', { count: d.frame.units })}
              </span>
            </h3>
            {d.frame.sources.length ? (
              <ul className="text-sm text-slate-700">
                {d.frame.sources.map((s) => (
                  <li key={s.label}>
                    {s.label || t('cases.sampling.unnamedSource')}:{' '}
                    {t('cases.sampling.frameUnits', { count: s.units })}
                  </li>
                ))}
              </ul>
            ) : null}
            {importing ? (
              <div className="flex flex-col gap-3">
                <label className="flex max-w-md flex-col gap-1 text-sm">
                  <span className="font-medium text-slate-700">
                    {t('cases.sampling.sourceLabel')}
                  </span>
                  <input
                    className={inputCls}
                    value={sourceLabel}
                    placeholder={t('cases.sampling.sourceLabelPlaceholder')}
                    onChange={(e) => setSourceLabel(e.target.value)}
                  />
                </label>
                <ImportTab
                  projectId={projectId}
                  target="frame"
                  sourceLabel={sourceLabel}
                  onDone={() => setImporting(false)}
                />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" onClick={() => setImporting(true)}>
                  {locked ? t('cases.sampling.addAfter') : t('cases.import.title')}
                </Button>
                {locked ? (
                  <span className="text-xs text-slate-600">{t('cases.sampling.addAfterHelp')}</span>
                ) : null}
                {d.frame.units && !locked ? (
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() =>
                      window.confirm(t('cases.sampling.confirmClear')) && clear.mutate()
                    }
                  >
                    {t('cases.sampling.clearFrame')}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </Layer>

      {/* Layer 2 */}
      <Layer
        title={t('cases.sampling.layer2')}
        help={t('cases.sampling.layer2Help')}
        testId="layer-2"
      >
        <Choice
          legend={t('cases.sampling.layer2')}
          tip="family"
          value={plan.design.family}
          disabled={locked}
          columns={4}
          options={(['probability', 'nonprobability', 'special', 'census'] as const).map((f) => ({
            value: f,
            label: t(`cases.sampling.families.${f}`),
            ...(f === 'census' ? { tip: 'census' } : {}),
            hint: t(`cases.sampling.familyHints.${f}`),
          }))}
          onChange={(family) => setDesign({ family, method: METHODS[family][0]! })}
        />
        {plan.design.family !== 'census' ? (
          <Choice
            legend={t(`cases.sampling.families.${plan.design.family}`)}
            value={m}
            disabled={locked}
            columns={3}
            options={METHODS[plan.design.family].map((x) => ({
              value: x,
              label: t(`cases.sampling.methods.${x}`),
              tip: x,
              hint: t(`cases.sampling.methodHints.${x}`),
            }))}
            onChange={(method) => setDesign({ method })}
          />
        ) : null}
        {probability ? (
          <div className="flex flex-wrap gap-4">
            {m === 'stratified' || m === 'multistage' ? (
              <VarSelect
                label={t('cases.sampling.strataVar')}
                tip="strataVar"
                value={plan.design.strataVar}
                fields={d.fields}
                disabled={locked}
                onChange={(strataVar) => setDesign({ strataVar })}
              />
            ) : null}
            {m === 'cluster' || m === 'multistage' ? (
              <VarSelect
                label={t('cases.sampling.clusterVar')}
                tip="clusterVar"
                value={plan.design.clusterVar}
                fields={d.fields}
                disabled={locked}
                onChange={(clusterVar) => setDesign({ clusterVar })}
              />
            ) : null}
            {(m === 'cluster' && plan.design.pps) || m === 'multistage' ? (
              <VarSelect
                label={t('cases.sampling.sizeVar')}
                tip="sizeVar"
                value={plan.design.sizeVar}
                fields={d.fields}
                disabled={locked}
                onChange={(sizeVar) => setDesign({ sizeVar })}
              />
            ) : null}
            {m === 'systematic' || (m === 'stratified' && plan.design.within === 'systematic') ? (
              <VarSelect
                label={t('cases.sampling.sortVar')}
                tip="sortVar"
                value={plan.design.sortVar}
                fields={d.fields}
                disabled={locked}
                onChange={(sortVar) => setDesign({ sortVar })}
              />
            ) : null}
            {m === 'stratified' ? (
              <>
                <div className="flex flex-col gap-1 text-sm">
                  <span className="flex items-center">
                    <label htmlFor="sp-allocation" className="font-medium text-slate-700">
                      {t('cases.sampling.allocation')}
                    </label>
                    <InfoTip id="allocation" term={t('cases.sampling.allocation')} />
                  </span>
                  <select
                    id="sp-allocation"
                    className={`${controlCls} w-auto`}
                    value={plan.design.allocation}
                    disabled={locked}
                    onChange={(e) =>
                      setDesign({ allocation: e.target.value as Plan['design']['allocation'] })
                    }
                  >
                    {(['proportional', 'equal', 'manual'] as const).map((a) => (
                      <option key={a} value={a}>
                        {t(`cases.sampling.allocations.${a}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1 text-sm">
                  <span className="flex items-center">
                    <label htmlFor="sp-within" className="font-medium text-slate-700">
                      {t('cases.sampling.within')}
                    </label>
                    <InfoTip id="within" term={t('cases.sampling.within')} />
                  </span>
                  <select
                    id="sp-within"
                    className={`${controlCls} w-auto`}
                    value={plan.design.within}
                    disabled={locked}
                    onChange={(e) => setDesign({ within: e.target.value as 'srs' | 'systematic' })}
                  >
                    {(['srs', 'systematic'] as const).map((w) => (
                      <option key={w} value={w}>
                        {t(`cases.sampling.methods.${w}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}
            {m === 'cluster' || m === 'multistage' ? (
              <>
                <Num
                  label={
                    m === 'multistage'
                      ? t('cases.sampling.clustersPerStratum')
                      : t('cases.sampling.clusters')
                  }
                  tip="clusters"
                  value={plan.design.clusters}
                  step="1"
                  min={1}
                  disabled={locked}
                  onChange={(n) => setDesign({ clusters: Math.max(1, Math.round(n ?? 1)) })}
                />
                <Num
                  label={t('cases.sampling.perCluster')}
                  tip="perCluster"
                  value={plan.design.perCluster}
                  step="1"
                  min={0}
                  disabled={locked}
                  onChange={(n) => setDesign({ perCluster: Math.max(0, Math.round(n ?? 0)) })}
                />
                {m === 'cluster' ? (
                  <span className="flex items-center self-end">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={plan.design.pps}
                        disabled={locked}
                        onChange={(e) => setDesign({ pps: e.target.checked })}
                      />
                      {t('cases.sampling.pps')}
                    </label>
                    <InfoTip id="pps" term={t('cases.sampling.pps')} />
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {probability && m === 'stratified' && plan.design.allocation === 'manual' ? (
          <div className="flex flex-wrap gap-3">
            {d.frame.byStratum.map((s) => (
              <Num
                key={s.stratum}
                label={t('cases.sampling.perStratumN', {
                  stratum: s.stratum || '—',
                  units: s.units,
                })}
                value={plan.design.perStratum[s.stratum] ?? 0}
                step="1"
                min={0}
                disabled={locked}
                onChange={(n) =>
                  setDesign({
                    perStratum: {
                      ...plan.design.perStratum,
                      [s.stratum]: Math.max(0, Math.round(n ?? 0)),
                    },
                  })
                }
              />
            ))}
          </div>
        ) : null}
        {!probability && plan.design.family !== 'census' ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">
              {t('cases.sampling.methodDescription')}
            </span>
            <textarea
              className={inputCls}
              rows={2}
              value={plan.design.description}
              disabled={locked}
              onChange={(e) => setDesign({ description: e.target.value })}
            />
          </label>
        ) : null}

        <div className="flex flex-col gap-2 border-t border-slate-200 pt-4" data-testid="quotas">
          <h3 className="flex items-center font-semibold">
            {t('cases.sampling.quotas')}
            <InfoTip id="quotas" term={t('cases.sampling.quotas')} />
          </h3>
          <p className="text-xs text-slate-600">
            {probability || census
              ? t('cases.sampling.quotasHelpProb')
              : t('cases.sampling.quotasHelpNonProb')}
          </p>
          {plan.quotas.map((q, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-sm">
                <span>{t('cases.sampling.quotaName')}</span>
                <input
                  className={`${inputCls} w-40`}
                  value={q.name}
                  onChange={(e) =>
                    set({
                      quotas: plan.quotas.map((x, j) =>
                        j === i ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>{t('cases.sampling.quotaWhen')}</span>
                <input
                  className={`${inputCls} w-64 font-mono`}
                  value={q.when}
                  placeholder="case.sex == 2"
                  onChange={(e) =>
                    set({
                      quotas: plan.quotas.map((x, j) =>
                        j === i ? { ...x, when: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <Num
                label={t('cases.sampling.quotaTarget')}
                value={q.target}
                step="1"
                min={0}
                onChange={(n) =>
                  set({
                    quotas: plan.quotas.map((x, j) =>
                      j === i ? { ...x, target: Math.max(0, Math.round(n ?? 0)) } : x,
                    ),
                  })
                }
              />
              <button
                type="button"
                className={smallBtn}
                onClick={() => set({ quotas: plan.quotas.filter((_, j) => j !== i) })}
              >
                {t('cases.sampling.removeQuota', { name: q.name || i + 1 })}
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className={smallBtn}
              onClick={() =>
                set({
                  quotas: [
                    ...plan.quotas,
                    { name: `C${plan.quotas.length + 1}`, when: '', target: 0 },
                  ],
                })
              }
            >
              {t('cases.sampling.addQuota')}
            </button>
          </div>
        </div>
      </Layer>

      {/* Layer 3 */}
      <Layer
        title={t('cases.sampling.layer3')}
        help={t('cases.sampling.layer3Help')}
        testId="layer-3"
      >
        <div className="flex flex-col gap-3">
          <h3 className="flex items-center font-semibold">
            {t('cases.sampling.size')}
            <InfoTip id="sizes" term={t('cases.sampling.size')} />
          </h3>
          {census ? (
            <p className="text-sm text-slate-700">{t('cases.sampling.censusSize')}</p>
          ) : null}
          {/* Two panels on wide screens: what precision is wanted, and what is lost on the way. */}
          <div className="grid gap-4 lg:grid-cols-2">
            <fieldset
              className={census ? 'hidden' : 'rounded-lg border border-slate-200 bg-white p-4'}
            >
              <legend className="px-1 text-sm font-semibold text-slate-700">
                {t('cases.sampling.precision')}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1 text-sm sm:col-span-2">
                  <span className="flex items-center">
                    <label htmlFor="sp-objective" className="font-medium text-slate-700">
                      {t('cases.sampling.objective')}
                    </label>
                    <InfoTip id="objective" term={t('cases.sampling.objective')} />
                  </span>
                  <select
                    id="sp-objective"
                    className={`${controlCls} w-full`}
                    value={plan.size.objective}
                    disabled={locked}
                    onChange={(e) =>
                      setSize({ objective: e.target.value as Plan['size']['objective'] })
                    }
                  >
                    {(['proportion', 'mean', 'difference', 'fixed'] as const).map((o) => (
                      <option key={o} value={o}>
                        {t(`cases.sampling.objectives.${o}`)}
                      </option>
                    ))}
                  </select>
                </div>
                {plan.size.objective === 'fixed' ? (
                  <Num
                    label={t('cases.sampling.fixedN')}
                    tip="fixedN"
                    value={plan.size.fixedN}
                    step="1"
                    min={1}
                    disabled={locked}
                    onChange={(n) => setSize({ fixedN: Math.max(1, Math.round(n ?? 1)) })}
                  />
                ) : (
                  <Num
                    label={t('cases.sampling.confidence')}
                    tip="confidence"
                    value={plan.size.confidence}
                    percent
                    disabled={locked}
                    onChange={(n) =>
                      n && setSize({ confidence: Math.min(0.999, Math.max(0.5, n)) })
                    }
                  />
                )}
                {plan.size.objective === 'proportion' ? (
                  <>
                    <Num
                      label={t('cases.sampling.margin')}
                      tip="margin"
                      value={plan.size.margin}
                      percent
                      disabled={locked}
                      onChange={(n) => n && setSize({ margin: n })}
                    />
                    <Num
                      label={t('cases.sampling.p')}
                      tip="p"
                      value={plan.size.p}
                      percent
                      disabled={locked}
                      onChange={(n) => n && setSize({ p: Math.min(0.99, Math.max(0.01, n)) })}
                    />
                  </>
                ) : null}
                {plan.size.objective === 'mean' ? (
                  <>
                    <Num
                      label={t('cases.sampling.marginMean')}
                      tip="marginMean"
                      value={plan.size.margin}
                      disabled={locked}
                      onChange={(n) => n && setSize({ margin: n })}
                    />
                    <Num
                      label={t('cases.sampling.sd')}
                      tip="sd"
                      value={plan.size.sd}
                      disabled={locked}
                      onChange={(n) => n && setSize({ sd: n })}
                    />
                  </>
                ) : null}
                {plan.size.objective === 'difference' ? (
                  <>
                    <Num
                      label={t('cases.sampling.p1')}
                      tip="p1"
                      value={plan.size.p1}
                      percent
                      disabled={locked}
                      onChange={(n) => n && setSize({ p1: Math.min(0.99, Math.max(0.01, n)) })}
                    />
                    <Num
                      label={t('cases.sampling.p2')}
                      tip="p2"
                      value={plan.size.p2}
                      percent
                      disabled={locked}
                      onChange={(n) => n && setSize({ p2: Math.min(0.99, Math.max(0.01, n)) })}
                    />
                    <Num
                      label={t('cases.sampling.power')}
                      tip="power"
                      value={plan.size.power}
                      percent
                      disabled={locked}
                      onChange={(n) => n && setSize({ power: Math.min(0.99, Math.max(0.5, n)) })}
                    />
                  </>
                ) : null}
                {plan.size.objective !== 'fixed' ? (
                  <Num
                    label={t('cases.sampling.deff')}
                    tip="deff"
                    value={plan.size.deff}
                    disabled={locked}
                    onChange={(n) => n && setSize({ deff: Math.max(1, n) })}
                  />
                ) : null}
              </div>
            </fieldset>
            <fieldset className="rounded-lg border border-slate-200 bg-white p-4">
              <legend className="px-1 text-sm font-semibold text-slate-700">
                {t('cases.sampling.losses')}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {census ? null : (
                  <Num
                    label={t('cases.sampling.eligibilityRate')}
                    tip="eligibilityRate"
                    value={plan.size.eligibility}
                    percent
                    disabled={locked}
                    onChange={(n) => n && setSize({ eligibility: Math.min(1, Math.max(0.01, n)) })}
                  />
                )}
                <Num
                  label={t('cases.sampling.responseRate')}
                  tip="responseRate"
                  value={plan.size.response}
                  percent
                  disabled={locked}
                  onChange={(n) => n && setSize({ response: Math.min(1, Math.max(0.01, n)) })}
                />
                {census ? null : (
                  <Num
                    label={t('cases.sampling.reserveRate')}
                    tip="reserveRate"
                    value={plan.size.reserve}
                    percent
                    disabled={locked}
                    onChange={(n) => setSize({ reserve: Math.max(0, n ?? 0) })}
                  />
                )}
              </div>
            </fieldset>
          </div>
          <dl className="grid gap-3 sm:grid-cols-3" data-testid="sizes">
            {(
              [
                ['required', sizes.required],
                ['toSelect', sizes.selected],
                ['toField', sizes.cases],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-lg border border-slate-200 bg-white p-3">
                <dt className="text-xs text-slate-600">{t(`cases.sampling.${k}`)}</dt>
                <dd className="text-2xl font-semibold tabular-nums" data-size={k}>
                  {fmt(v)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-slate-600">
            {t('cases.sampling.decision2')}{' '}
            {sizes.fpcApplied && sizes.population
              ? t('cases.sampling.fpc', { n: fmt(sizes.population) })
              : t('cases.sampling.noFpc')}
            <InfoTip id="fpc" term="FPC" />
          </p>
        </div>

        <div className="grid gap-4 border-t border-slate-200 pt-4 md:grid-cols-2">
          <div className="flex flex-col gap-1 text-sm">
            <span className="flex items-center">
              <label htmlFor="sp-eligibility" className="font-medium text-slate-700">
                {t('cases.sampling.eligibility')}
              </label>
              <InfoTip id="eligibility" term={t('cases.sampling.eligibility')} />
            </span>
            <input
              id="sp-eligibility"
              className={`${inputCls} font-mono`}
              value={plan.eligibility ?? ''}
              disabled={locked}
              placeholder="case.age >= 18"
              onChange={(e) => set({ eligibility: e.target.value || null })}
            />
            <span className="text-xs text-slate-600">{t('cases.sampling.eligibilityHelp')}</span>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <span className="flex items-center">
              <label htmlFor="sp-exclusions" className="font-medium text-slate-700">
                {t('cases.sampling.exclusions')}
              </label>
              <InfoTip id="exclusions" term={t('cases.sampling.exclusions')} />
            </span>
            <input
              id="sp-exclusions"
              className={`${inputCls} font-mono`}
              value={plan.exclusions ?? ''}
              disabled={locked}
              onChange={(e) => set({ exclusions: e.target.value || null })}
            />
            <span className="text-xs text-slate-600">{t('cases.sampling.exclusionsHelp')}</span>
          </div>
        </div>
        {/* Applies to units loaded or selected from now on, so it stays editable. */}
        <CrossChecks
          value={plan.crossChecks ?? []}
          fields={[...new Set([...d.fields, ...(sampleFields.data ?? []).map((f) => f.name)])]}
          onChange={(crossChecks) => set({ crossChecks })}
        />
        {d.frame.crossChecked ? (
          <p className="text-sm" data-testid="cross-checked">
            {t('cases.sampling.cross.excluded', { count: d.frame.crossChecked })}
          </p>
        ) : null}
        {usesFrame ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm" data-testid="frame-summary">
              {t('cases.sampling.frameSummary', d.frame)}
            </p>
            {d.frame.byStratum.length ? (
              <table className="w-auto text-sm">
                <caption className="mb-1 text-left font-medium">
                  {t('cases.sampling.strataTable')}
                </caption>
                <thead>
                  <tr className="text-left text-xs text-slate-600">
                    <th scope="col" className="pr-6">
                      {t('cases.sampling.stratum')}
                    </th>
                    <th scope="col" className="text-right">
                      {t('cases.sampling.units')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.frame.byStratum.map((s) => (
                    <tr key={s.stratum}>
                      <td className="pr-6">{s.stratum || '—'}</td>
                      <td className="text-right tabular-nums">{fmt(s.units)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        ) : null}

        <div
          className="flex flex-col gap-2 border-t border-slate-200 pt-4"
          data-testid="substitution"
        >
          <h3 className="flex items-center font-semibold">
            {t('cases.sampling.substitution')}
            <InfoTip id="substitution" term={t('cases.sampling.substitution')} />
          </h3>
          <p className="text-xs text-slate-600">{t('cases.sampling.substitutionHelp')}</p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={plan.substitution.allowed}
              onChange={(e) =>
                set({ substitution: { ...plan.substitution, allowed: e.target.checked } })
              }
            />
            {t('cases.sampling.allowSubstitution')}
          </label>
          {plan.substitution.allowed ? (
            <div className="flex flex-wrap gap-4">
              <div className="flex flex-col gap-1 text-sm">
                <span className="flex items-center">
                  <label htmlFor="sp-rule" className="font-medium text-slate-700">
                    {t('cases.sampling.rule')}
                  </label>
                  <InfoTip id="rule" term={t('cases.sampling.rule')} />
                </span>
                <select
                  id="sp-rule"
                  className={`${controlCls} w-auto`}
                  value={plan.substitution.rule}
                  onChange={(e) =>
                    set({
                      substitution: {
                        ...plan.substitution,
                        rule: e.target.value as 'sameStratum' | 'nextReserve',
                      },
                    })
                  }
                >
                  {(['sameStratum', 'nextReserve'] as const).map((r) => (
                    <option key={r} value={r}>
                      {t(`cases.sampling.rules.${r}`)}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset className="text-sm">
                <legend className="mb-1 font-medium text-slate-700">
                  {t('cases.sampling.reasons')}
                  <InfoTip id="reasons" term={t('cases.sampling.reasons')} />
                </legend>
                <div className="flex flex-wrap gap-3">
                  {Object.keys(DISPOSITIONS)
                    .filter(
                      (k) => DISPOSITIONS[k as keyof typeof DISPOSITIONS].group !== 'interview',
                    )
                    .filter((k) => DISPOSITIONS[k as keyof typeof DISPOSITIONS].final)
                    .map((k) => (
                      <label key={k} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={plan.substitution.reasons.includes(k)}
                          onChange={(e) =>
                            set({
                              substitution: {
                                ...plan.substitution,
                                reasons: e.target.checked
                                  ? [...plan.substitution.reasons, k]
                                  : plan.substitution.reasons.filter((x) => x !== k),
                              },
                            })
                          }
                        />
                        {dispositionLabel(t, k)}
                      </label>
                    ))}
                </div>
              </fieldset>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-200 pt-4">
          <h3 className="font-semibold">{t('cases.sampling.checks')}</h3>
          <ul className="flex flex-col gap-1.5" data-testid="checks">
            {checks.map((c, i) => (
              <li
                key={i}
                className={`flex gap-2 rounded-md border px-3 py-1.5 text-sm ${sevCls[c.severity]}`}
                data-check={c.code}
                data-severity={c.severity}
              >
                <span aria-hidden className="font-bold">
                  {sevIcon[c.severity]}
                </span>
                {t(`cases.sampling.check.${c.code}`, c.params ?? {})}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => save.mutate(plan)}
            disabled={save.isPending}
          >
            {t('cases.sampling.save')}
          </Button>
          {!locked && usesFrame ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => runPreview.mutate(plan)}
              disabled={runPreview.isPending}
            >
              {t('cases.sampling.preview')}
            </Button>
          ) : null}
          {!locked && usesFrame ? (
            <Button
              type="button"
              disabled={select.isPending || checks.some((c) => c.severity === 'error')}
              onClick={() =>
                window.confirm(t('cases.sampling.confirmSelect')) && select.mutate(plan)
              }
            >
              {t('cases.sampling.select')}
            </Button>
          ) : null}
          <p role="status" className="text-sm text-emerald-ink-800">
            {message}
          </p>
        </div>
        <ErrorText>{error}</ErrorText>

        {preview ? (
          <div
            className="flex flex-col gap-2 rounded-lg bg-slate-50 p-3 text-sm"
            data-testid="preview"
          >
            <h3 className="font-semibold">
              {t('cases.sampling.previewTitle', { seed: d.seed ?? '' })}
            </h3>
            <p>
              {t('cases.sampling.selectedCount', { count: preview.selected })} ·{' '}
              {t('cases.sampling.reservesCount', { count: preview.reserves })}
            </p>
            {preview.prob ? (
              <p>
                {t('cases.sampling.probRange', {
                  min: pct(preview.prob.min),
                  max: pct(preview.prob.max),
                  wmin: pct(1 / preview.prob.max),
                  wmax: pct(1 / preview.prob.min),
                })}
              </p>
            ) : (
              <p>{t('cases.sampling.noProb')}</p>
            )}
            {preview.strata.length > 1 ? (
              <table className="w-auto">
                <thead>
                  <tr className="text-left text-xs text-slate-600">
                    <th scope="col" className="pr-6">
                      {t('cases.sampling.stratum')}
                    </th>
                    <th scope="col" className="pr-6 text-right">
                      N
                    </th>
                    <th scope="col" className="pr-6 text-right">
                      n
                    </th>
                    <th scope="col" className="text-right">
                      {t('cases.sampling.reserveRate')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.strata.map((s) => (
                    <tr key={s.stratum}>
                      <td className="pr-6">{s.stratum || '—'}</td>
                      <td className="pr-6 text-right tabular-nums">{s.population}</td>
                      <td className="pr-6 text-right tabular-nums">{s.selected}</td>
                      <td className="text-right tabular-nums">{s.reserve}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {preview.warnings.map((w) => {
              const [code, a, b, c] = w.split(':');
              return (
                <p key={w} className="text-amber-ink-900">
                  ! {t(`cases.sampling.warning.${code}`, { a, b, c })}
                </p>
              );
            })}
          </div>
        ) : null}
      </Layer>

      {/* Cases */}
      <Layer title={t('cases.sampling.layer4')} help="" testId="layer-4">
        {locked && d.selectedAt ? (
          <p className="text-sm" data-testid="selected-on">
            {t('cases.sampling.selectedOn', { date: dateTime(d.selectedAt), seed: d.seed ?? '' })}
          </p>
        ) : null}
        <div>
          <h3 className="mb-1 text-sm font-medium">{t('cases.sampling.rolesTitle')}</h3>
          <ul className="flex flex-wrap gap-3 text-sm" data-testid="roles">
            {Object.entries(d.cases).map(([role, n]) => (
              <li key={role} className="rounded-md bg-slate-100 px-2 py-0.5" data-role={role}>
                {t(`cases.sampling.roles.${role}`, { defaultValue: role })}: <strong>{n}</strong>
              </li>
            ))}
          </ul>
        </div>
        {locked ? <ReleaseForm projectId={projectId} data={d} onDone={refresh} /> : null}
        {locked &&
        probability &&
        ['srs', 'systematic', 'stratified'].includes(plan.design.method) ? (
          <BatchForm projectId={projectId} data={d} onDone={refresh} />
        ) : null}
        {!usesFrame || (plan.design.family !== 'probability' && plan.source.kind === 'field') ? (
          <FieldForm projectId={projectId} onDone={refresh} />
        ) : null}
      </Layer>
    </div>
  );
}

/** Another batch from the units never selected, added to the cases already in the sample. */
function BatchForm({
  projectId,
  data,
  onDone,
}: {
  projectId: string;
  data: Sampling;
  onDone(): Promise<void>;
}) {
  const { t } = useTranslation();
  const scoped = useScoped();
  const [count, setCount] = useState(10);
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api<{ added: number }>(scoped(`/projects/${projectId}/sampling/batch`), {
        method: 'POST',
        body: { count, reason },
      }),
    onSuccess: async (r) => {
      setStatus(t('cases.sampling.batchDone', { count: r.added }));
      setReason('');
      setError(null);
      await onDone();
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  return (
    <form
      className="flex flex-col gap-2 border-t border-slate-200 pt-3"
      data-testid="batch"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) add.mutate();
      }}
    >
      <h3 className="font-semibold">
        {t('cases.sampling.batch')} ·{' '}
        <span className="font-normal text-slate-600">
          {t('cases.sampling.unitsLeft', { count: data.unitsLeft })}
        </span>
      </h3>
      <p className="text-sm text-slate-600">{t('cases.sampling.batchHelp')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Num
          label={t('cases.sampling.batchCount')}
          value={count}
          step="1"
          min={1}
          onChange={(n) => setCount(Math.max(1, Math.round(n ?? 1)))}
        />
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">{t('cases.sampling.releaseReason')}</span>
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <Button type="submit" disabled={!reason.trim() || !data.unitsLeft || add.isPending}>
          {t('cases.sampling.batchAdd')}
        </Button>
      </div>
      <p role="status" className="text-sm text-emerald-ink-800">
        {status}
      </p>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

function ReleaseForm({
  projectId,
  data,
  onDone,
}: {
  projectId: string;
  data: Sampling;
  onDone(): Promise<void>;
}) {
  const { t } = useTranslation();
  const scoped = useScoped();
  const [count, setCount] = useState(1);
  const [stratum, setStratum] = useState('');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const release = useMutation({
    mutationFn: () =>
      api<{ released: number }>(scoped(`/projects/${projectId}/sampling/release`), {
        method: 'POST',
        body: { count, stratum: stratum || null, reason },
      }),
    onSuccess: async (r) => {
      setStatus(t('cases.sampling.releaseDone', { count: r.released }));
      setReason('');
      setError(null);
      await onDone();
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  return (
    <form
      className="flex flex-col gap-2 border-t border-slate-200 pt-3"
      data-testid="release"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) release.mutate();
      }}
    >
      <h3 className="font-semibold">
        {t('cases.sampling.release')} ·{' '}
        <span className="font-normal text-slate-600">
          {t('cases.sampling.reservesLeft', { count: data.reservesLeft })}
        </span>
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <Num
          label={t('cases.sampling.releaseCount')}
          value={count}
          step="1"
          min={1}
          onChange={(n) => setCount(Math.max(1, Math.round(n ?? 1)))}
        />
        {data.frame.byStratum.length ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{t('cases.sampling.releaseStratum')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={stratum}
              onChange={(e) => setStratum(e.target.value)}
            >
              <option value="">{t('cases.sampling.anyStratum')}</option>
              {data.frame.byStratum.map((s) => (
                <option key={s.stratum} value={s.stratum}>
                  {s.stratum || '—'}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">{t('cases.sampling.releaseReason')}</span>
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <Button type="submit" disabled={!reason.trim() || !data.reservesLeft || release.isPending}>
          {t('cases.sampling.release')}
        </Button>
      </div>
      <p role="status" className="text-sm text-emerald-ink-800">
        {status}
      </p>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

function FieldForm({ projectId, onDone }: { projectId: string; onDone(): Promise<void> }) {
  const { t } = useTranslation();
  const scoped = useScoped();
  const [count, setCount] = useState(10);
  const [prefix, setPrefix] = useState('F');
  const [cell, setCell] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const make = useMutation({
    mutationFn: () =>
      api<{ created: number }>(scoped(`/projects/${projectId}/sampling/field-cases`), {
        method: 'POST',
        body: { count, prefix, ...(cell.trim() ? { cell: cell.trim() } : {}) },
      }),
    onSuccess: async (r) => {
      setStatus(t('cases.sampling.fieldDone', { count: r.created }));
      setError(null);
      await onDone();
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  return (
    <form
      className="flex flex-col gap-2 border-t border-slate-200 pt-3"
      data-testid="field-cases"
      onSubmit={(e) => {
        e.preventDefault();
        make.mutate();
      }}
    >
      <h3 className="font-semibold">{t('cases.sampling.fieldCases')}</h3>
      <p className="text-xs text-slate-600">{t('cases.sampling.fieldHelp')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Num
          label={t('cases.sampling.fieldCount')}
          value={count}
          step="1"
          min={1}
          onChange={(n) => setCount(Math.max(1, Math.round(n ?? 1)))}
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">{t('cases.sampling.fieldPrefix')}</span>
          <input
            className={`${inputCls} w-28 font-mono`}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
          />
        </label>
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">{t('cases.sampling.fieldCell')}</span>
          <input className={inputCls} value={cell} onChange={(e) => setCell(e.target.value)} />
        </label>
        <Button type="submit" disabled={!prefix || make.isPending}>
          {t('cases.sampling.fieldCreate')}
        </Button>
      </div>
      <p role="status" className="text-sm text-emerald-ink-800">
        {status}
      </p>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}
