import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useScoped } from './scope.js';
import { api } from '../api.js';
import { controlCls, inputCls } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button, ErrorText } from '../routes/ui.js';
import { Num } from './samplingControls.js';
import type { Sampling } from './SamplingTab.js';

/** Another batch from the units never selected, added to the cases already in the sample. */
export function BatchForm({
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
        <label className="flex min-w-0 sm:min-w-[16rem] flex-1 flex-col gap-1 text-sm">
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

export function ReleaseForm({
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
        <label className="flex min-w-0 sm:min-w-[16rem] flex-1 flex-col gap-1 text-sm">
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

export function FieldForm({ projectId, onDone }: { projectId: string; onDone(): Promise<void> }) {
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
        <label className="flex min-w-0 sm:min-w-[16rem] flex-1 flex-col gap-1 text-sm">
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
