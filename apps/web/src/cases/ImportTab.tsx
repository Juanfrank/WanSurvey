import './sampling-i18n.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuestionnaireScope, useScoped } from './scope.js';
import { api, upload } from '../api.js';
import { localiseError } from '../i18n-messages.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { Button, Card, ErrorText, FileInput } from '../routes/ui.js';
import { dateTime } from '../format.js';

type FieldType = 'text' | 'number' | 'date' | 'code';
type Column =
  | { kind: 'ignore' }
  | { kind: 'externalId' }
  | { kind: 'sample'; field: string; type: FieldType; pii: boolean }
  | { kind: 'contact'; type: 'phone' | 'email' | 'address'; label?: string }
  | { kind: 'priority' }
  | { kind: 'modePreference' };

interface Mapping {
  columns: Column[];
  existing: 'skip' | 'update';
  skipInvalid: boolean;
  defaultCountryCode?: string;
}

interface Uploaded {
  id: string;
  fileName: string;
  headers: string[];
  rows: number;
  preview: string[][];
  suggested: Mapping;
  duplicateOf: string | null;
}

interface Report {
  total: number;
  valid: number;
  invalid: number;
  empty: number;
  existing: number;
  toCreate: number;
  toUpdate: number;
  elsewhere?: { projectId: string; name: string; rows: number }[];
  issues: {
    code: string;
    count: number;
    blocking: boolean;
    examples: { row: number; column: string; value: string }[];
  }[];
}

type Target =
  | 'ignore'
  | 'externalId'
  | 'sample'
  | 'phone'
  | 'email'
  | 'address'
  | 'priority'
  | 'modePreference';

const targetOf = (c: Column): Target => (c.kind === 'contact' ? c.type : c.kind);

const fieldName = (h: string) => {
  const n = h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (/^[a-z]/.test(n) ? n : `f_${n}`).slice(0, 64);
};

/** Upload → map columns → validation report → commit. */
export function ImportTab({
  projectId,
  onDone,
  target = 'cases',
  sourceLabel,
}: {
  projectId: string;
  onDone(): void;
  /** frame: the rows become units of the sampling frame (S1), not cases. */
  target?: 'cases' | 'frame';
  sourceLabel?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const questionnaire = useQuestionnaireScope();
  const scoped = useScoped();
  const history = useQuery({
    queryKey: ['imports', projectId, questionnaire],
    queryFn: () =>
      api<{ id: string; fileName: string; rows: number; status: string; createdAt: string }[]>(
        scoped(`/projects/${projectId}/imports`),
      ),
  });
  const fail = (e: unknown) => setError(localiseError(t, e));

  const send = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      if (questionnaire) form.append('questionnaireId', questionnaire);
      if (target === 'frame') {
        form.append('target', 'frame');
        if (sourceLabel?.trim()) form.append('sourceLabel', sourceLabel.trim());
      }
      return upload<Uploaded>(`/projects/${projectId}/imports`, form);
    },
    onSuccess: (u) => {
      void qc.invalidateQueries({ queryKey: ['imports', projectId] });
      setUploaded(u);
      setMapping(u.suggested);
      setReport(null);
      setSummary(null);
      setError(null);
    },
    onError: fail,
  });
  const validate = useMutation({
    mutationFn: (m: Mapping) =>
      api<Report>(`/projects/${projectId}/imports/${uploaded!.id}/mapping`, {
        method: 'PUT',
        body: m,
      }),
    onSuccess: (r) => {
      setReport(r);
      setError(null);
    },
    onError: fail,
  });
  const commit = useMutation({
    mutationFn: async () => {
      // The skip-invalid choice is part of the stored mapping.
      await api(`/projects/${projectId}/imports/${uploaded!.id}/mapping`, {
        method: 'PUT',
        body: mapping,
      });
      return api<Record<string, number>>(`/projects/${projectId}/imports/${uploaded!.id}/commit`, {
        method: 'POST',
      });
    },
    onSuccess: async (s) => {
      setSummary(s);
      setError(null);
      await qc.invalidateQueries({ queryKey: ['cases', projectId] });
      await qc.invalidateQueries({ queryKey: ['imports', projectId] });
      await qc.invalidateQueries({ queryKey: ['sample-fields', projectId] });
      await qc.invalidateQueries({ queryKey: ['assignees', projectId] });
      await qc.invalidateQueries({ queryKey: ['sampling', projectId] });
    },
    onError: fail,
  });

  const setColumn = (i: number, c: Column) => {
    if (!mapping) return;
    const columns = mapping.columns.map((x, j) => {
      if (j === i) return c;
      // Only one id column.
      if (c.kind === 'externalId' && x.kind === 'externalId') return { kind: 'ignore' as const };
      return x;
    });
    setMapping({ ...mapping, columns });
    setReport(null);
  };
  const reset = () => {
    setUploaded(null);
    setMapping(null);
    setReport(null);
    setSummary(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t('cases.import.title')}</h2>
        <p className="text-sm text-slate-700">{t('cases.import.intro')}</p>
        {!uploaded ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const f = fileRef.current?.files?.[0];
              if (f) send.mutate(f);
            }}
          >
            <FileInput
              label={t('cases.import.file')}
              accept=".csv,.xlsx,.txt,.tsv"
              inputRef={fileRef}
            />
            <Button type="submit" disabled={send.isPending}>
              {send.isPending ? t('cases.import.reading') : t('cases.import.upload')}
            </Button>
          </form>
        ) : (
          <p className="text-sm">
            {t('cases.import.rowsRead', { count: uploaded.rows, file: uploaded.fileName })}{' '}
            <button type="button" className={smallBtn} onClick={reset}>
              {t('cases.import.another')}
            </button>
          </p>
        )}
        {uploaded?.duplicateOf ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-ink-900">
            {t('cases.import.duplicate')}
          </p>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </Card>

      {uploaded && mapping && !summary ? (
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">{t('cases.import.stepMap')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm" data-testid="mapping-table">
              <thead className="text-left text-xs text-slate-600">
                <tr>
                  <th scope="col" className="py-1 pr-2">
                    {t('cases.import.column')}
                  </th>
                  <th scope="col" className="pr-2">
                    {t('cases.import.examples')}
                  </th>
                  <th scope="col" className="pr-2">
                    {t('cases.import.target')}
                  </th>
                  <th scope="col" className="pr-2">
                    {t('cases.import.field')}
                  </th>
                  <th scope="col" className="pr-2">
                    {t('cases.import.type')}
                  </th>
                  <th scope="col">{t('cases.import.pii')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {uploaded.headers.map((h, i) => {
                  const c = mapping.columns[i]!;
                  const target = targetOf(c);
                  return (
                    <tr key={i} data-column={h}>
                      <th scope="row" className="py-1.5 pr-2 text-left font-medium">
                        {h}
                      </th>
                      <td className="max-w-[14rem] truncate pr-2 text-slate-600">
                        {uploaded.preview
                          .slice(0, 3)
                          .map((r) => r[i])
                          .filter(Boolean)
                          .join(' · ')}
                      </td>
                      <td className="pr-2">
                        <select
                          className={`${controlCls} w-auto`}
                          aria-label={`${t('cases.import.target')}: ${h}`}
                          value={target}
                          onChange={(e) => {
                            const v = e.target.value as Target;
                            setColumn(
                              i,
                              v === 'sample'
                                ? { kind: 'sample', field: fieldName(h), type: 'text', pii: false }
                                : v === 'phone' || v === 'email' || v === 'address'
                                  ? { kind: 'contact', type: v, label: h }
                                  : ({ kind: v } as Column),
                            );
                          }}
                        >
                          {(
                            [
                              'ignore',
                              'externalId',
                              'sample',
                              'phone',
                              'email',
                              'address',
                              'priority',
                              'modePreference',
                            ] as const
                          ).map((x) => (
                            <option key={x} value={x}>
                              {t(`cases.import.targets.${x}`)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="pr-2">
                        {c.kind === 'sample' ? (
                          <input
                            type="text"
                            className={`${controlCls} w-36 font-mono`}
                            aria-label={`${t('cases.import.field')}: ${h}`}
                            value={c.field}
                            onChange={(e) => setColumn(i, { ...c, field: e.target.value })}
                          />
                        ) : null}
                      </td>
                      <td className="pr-2">
                        {c.kind === 'sample' ? (
                          <select
                            className={`${controlCls} w-auto`}
                            aria-label={`${t('cases.import.type')}: ${h}`}
                            value={c.type}
                            onChange={(e) =>
                              setColumn(i, { ...c, type: e.target.value as FieldType })
                            }
                          >
                            {(['text', 'number', 'date', 'code'] as const).map((x) => (
                              <option key={x} value={x}>
                                {t(`cases.import.types.${x}`)}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </td>
                      <td>
                        {c.kind === 'sample' ? (
                          <input
                            type="checkbox"
                            aria-label={`${t('cases.import.pii')}: ${h}`}
                            checked={c.pii}
                            onChange={(e) => setColumn(i, { ...c, pii: e.target.checked })}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-6">
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="mb-1 font-medium">{t('cases.import.existing')}</legend>
              {(['skip', 'update'] as const).map((x) => (
                <label key={x} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="existing"
                    checked={mapping.existing === x}
                    onChange={() => {
                      setMapping({ ...mapping, existing: x });
                      setReport(null);
                    }}
                  />
                  {t(x === 'skip' ? 'cases.import.existingSkip' : 'cases.import.existingUpdate')}
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('cases.import.country')}</span>
              <input
                type="text"
                inputMode="numeric"
                className={`${controlCls} w-20`}
                aria-describedby="cc-help"
                value={mapping.defaultCountryCode ?? ''}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 4);
                  setMapping({ ...mapping, defaultCountryCode: v || undefined });
                  setReport(null);
                }}
              />
              <span id="cc-help" className="text-xs text-slate-600">
                {t('cases.import.countryHelp')}
              </span>
            </label>
          </div>
          <div>
            <Button
              type="button"
              disabled={validate.isPending}
              onClick={() => validate.mutate(mapping)}
            >
              {t('cases.import.validate')}
            </Button>
          </div>
        </Card>
      ) : null}

      {report && mapping && uploaded && !summary ? (
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">{t('cases.import.report.title')}</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" data-testid="import-report">
            {(
              [
                ['valid', report.valid],
                ['invalid', report.invalid],
                ['create', report.toCreate],
                ['update', report.toUpdate],
              ] as const
            ).map(([k, n]) => (
              <div key={k} className="rounded-md border border-slate-200 p-2" data-stat={k}>
                <dt className="text-xs text-slate-600">{t(`cases.import.report.${k}`)}</dt>
                <dd
                  className={`text-xl font-semibold ${k === 'invalid' && n ? 'text-red-ink-800' : ''}`}
                >
                  {n}
                </dd>
              </div>
            ))}
          </dl>
          {report.issues.length ? (
            <table className="w-full text-sm" data-testid="import-issues">
              <thead className="text-left text-xs text-slate-600">
                <tr>
                  <th scope="col" className="py-1">
                    {t('cases.import.report.issue')}
                  </th>
                  <th scope="col">{t('cases.import.report.count')}</th>
                  <th scope="col">{t('cases.import.report.example')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.issues.map((i) => (
                  <tr key={i.code} data-issue={i.code}>
                    <td className={`py-1.5 ${i.blocking ? 'text-red-ink-800' : ''}`}>
                      {t(`cases.import.issue.${i.code}`)}
                    </td>
                    <td>{i.count}</td>
                    <td className="text-slate-600">
                      {i.code === 'duplicate_elsewhere'
                        ? i.examples.map((e) => `${e.row}: ${e.column}`).join(' · ')
                        : i.examples.map((e) => `${e.row}: ${e.value || '∅'}`).join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm">{t('cases.import.report.noIssues')}</p>
          )}
          {report.elsewhere?.length ? (
            <p className="text-sm text-slate-700" data-testid="import-elsewhere">
              {t('cases.import.elsewhere', {
                list: report.elsewhere
                  .map((p) => t('cases.import.elsewhereRows', { name: p.name, count: p.rows }))
                  .join(', '),
              })}
            </p>
          ) : null}
          {report.invalid ? (
            <a
              className="text-sm text-indigo-ink-700 underline"
              href={`/api/v1/projects/${projectId}/imports/${uploaded.id}/report.csv`}
            >
              {t('cases.import.report.download')}
            </a>
          ) : null}
          {report.invalid ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={mapping.skipInvalid}
                onChange={(e) => setMapping({ ...mapping, skipInvalid: e.target.checked })}
              />
              {t('cases.import.skipInvalid', { count: report.invalid })}
            </label>
          ) : null}
          {report.invalid && !mapping.skipInvalid ? (
            <p className="text-sm text-slate-700">{t('cases.import.mustFix')}</p>
          ) : null}
          <div>
            <Button
              type="button"
              disabled={
                commit.isPending ||
                (report.invalid > 0 && !mapping.skipInvalid) ||
                report.toCreate + report.toUpdate === 0
              }
              onClick={() => commit.mutate()}
            >
              {target === 'frame'
                ? t('cases.sampling.loadFrame', { count: report.toCreate + report.toUpdate })
                : report.toUpdate
                  ? t('cases.import.commitUpdate', {
                      create: report.toCreate,
                      update: report.toUpdate,
                    })
                  : t('cases.import.commit', { count: report.toCreate })}
            </Button>
          </div>
        </Card>
      ) : null}

      {summary ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{t('cases.import.stepDone')}</h2>
          <p role="status" className="text-sm" data-testid="import-done">
            {target === 'frame'
              ? t('cases.sampling.frameLoaded', summary) +
                (summary.added !== undefined
                  ? ` ${t('cases.sampling.addedCases', { count: summary.added })}`
                  : '')
              : t('cases.import.done', summary)}
          </p>
          <div className="flex gap-2">
            <Button type="button" onClick={onDone}>
              {target === 'frame' ? t('cases.sampling.toDesign') : t('cases.import.viewCases')}
            </Button>
            <Button type="button" variant="secondary" onClick={reset}>
              {t('cases.import.another')}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 font-semibold">{t('cases.import.history')}</h2>
        {history.data?.length ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {history.data.map((h) => (
              <li key={h.id} className="flex flex-wrap gap-x-3 py-1.5">
                <span className="font-medium">{h.fileName}</span>
                <span>{h.rows}</span>
                <span>{t(`cases.import.statusLabel.${h.status}`, { defaultValue: h.status })}</span>
                <time className="text-slate-600">{dateTime(h.createdAt)}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">{t('cases.import.noHistory')}</p>
        )}
      </Card>
    </div>
  );
}
