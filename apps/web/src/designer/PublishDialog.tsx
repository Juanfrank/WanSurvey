import { useQueryClient } from '@tanstack/react-query';
import type { BreakingChange } from '@wansurvey/logic';
import type { MappingAction, VersionMapping } from '@wansurvey/schema';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api.js';
import { Button } from '../routes/ui.js';
import { toLiteral } from './ConditionBuilder.js';
import { Dialog } from './Dialog.js';
import { controlCls } from './fields.js';
import type { PublishCheckResult } from './hooks.js';
import type { Draft } from './tree.js';
import { variablesOf } from './vars.js';

/**
 * Saves the draft, runs every publish check on the server and, when breaking changes need it,
 * collects the mapping from the previous version before publishing.
 */
export function PublishDialog({
  projectId,
  qid,
  draft,
  flush,
  onClose,
  onPublished,
}: {
  projectId: string;
  qid: string;
  draft: Draft;
  flush(): Promise<number | null>;
  onClose(): void;
  onPublished(version: number): void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [revision, setRevision] = useState<number | null>(null);
  const [check, setCheck] = useState<PublishCheckResult | null>(null);
  const [mapping, setMapping] = useState<VersionMapping>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const url = `/projects/${projectId}/questionnaires/${qid}`;
  const vars = variablesOf(draft, draft.defaultLanguage);

  useEffect(() => {
    void (async () => {
      const rev = await flush();
      if (rev === null) setError(t('designer.publish.saveFirst'));
      else setRevision(rev);
    })();
  }, []);

  useEffect(() => {
    if (revision === null) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await api<PublishCheckResult>(`${url}/publish-check`, {
          method: 'POST',
          body: { mapping },
        });
        if (mine === seq.current) setCheck(res);
      } catch (e) {
        setError((e as Error).message);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [revision, mapping, url]);

  const publish = async () => {
    if (revision === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ version: number }>(`${url}/publish`, {
        method: 'POST',
        body: { baseRevision: revision, ...(check?.breaking.length ? { mapping } : {}) },
      });
      await qc.invalidateQueries({ queryKey: ['versions', qid] });
      onPublished(res.version);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PUBLISH_BLOCKED') {
        setCheck({ ...(e.body.check as PublishCheckResult), draftRevision: revision });
      } else setError(e instanceof ApiError ? (e.body.message ?? e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const errors = check?.diagnostics.filter((d) => d.severity === 'error') ?? [];
  const failing = check?.scenarios.filter((s) => !s.passed) ?? [];
  const nextVersion = (check?.previousVersion ?? 0) + 1;

  return (
    <Dialog title={t('designer.publish.title')} onClose={onClose} wide>
      <div className="flex flex-col gap-5 text-sm" aria-busy={!check}>
        {error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-800">
            {error}
          </p>
        ) : null}
        {!check && !error ? <p role="status">{t('designer.publish.checking')}</p> : null}
        {check ? (
          <>
            <ul className="flex flex-col gap-1" aria-label={t('designer.publish.checks')}>
              <CheckLine
                ok={!check.schemaIssues.length && !errors.length}
                text={
                  check.schemaIssues.length || errors.length
                    ? t('designer.publish.errors', {
                        count: check.schemaIssues.length + errors.length,
                      })
                    : t('designer.publish.noErrors')
                }
              />
              <CheckLine
                ok={!failing.length}
                text={
                  check.scenarios.length === 0
                    ? t('designer.publish.noScenarios')
                    : failing.length
                      ? t('designer.publish.scenariosFailed', {
                          count: failing.length,
                          total: check.scenarios.length,
                        })
                      : t('designer.publish.scenariosPassed', { count: check.scenarios.length })
                }
              />
              <CheckLine
                ok={!check.mappingProblems.length}
                text={
                  check.previousVersion === null
                    ? t('designer.publish.firstVersion')
                    : check.breaking.length
                      ? t('designer.publish.breaking', { count: check.breaking.length })
                      : t('designer.publish.compatible', { version: check.previousVersion })
                }
              />
              {check.unchanged ? (
                <CheckLine
                  ok={false}
                  text={t('designer.publish.unchanged', { version: check.previousVersion })}
                />
              ) : null}
            </ul>

            {[
              ...check.schemaIssues.map((i) => `${i.path}: ${i.message}`),
              ...errors.map((d) => d.message),
            ]
              .slice(0, 8)
              .map((m, i) => (
                <p key={i} className="-mt-3 pl-6 text-red-800">
                  {m}
                </p>
              ))}

            {failing.map((s) => (
              <div key={s.id} className="-mt-3 pl-6">
                <p className="font-medium">{s.name}</p>
                <ul className="list-disc pl-5 text-red-800">
                  {s.checks
                    .filter((c) => !c.passed)
                    .map((c, i) => (
                      <li key={i}>
                        {c.label}
                        {c.detail ? ` — ${c.detail}` : ''}
                      </li>
                    ))}
                </ul>
              </div>
            ))}

            {check.breaking.length ? (
              <section aria-labelledby="mapping-h" className="flex flex-col gap-3">
                <h3 id="mapping-h" className="font-semibold">
                  {t('designer.publish.mappingTitle', { version: check.previousVersion })}
                </h3>
                <p className="text-slate-600">{t('designer.publish.mappingHelp')}</p>
                {check.breaking.map((b) => (
                  <MappingRow
                    key={b.id}
                    change={b}
                    action={mapping[b.id]}
                    variables={vars}
                    problems={check.mappingProblems
                      .filter((p) => p.changeId === b.id)
                      .map((p) => p.message)}
                    onChange={(a) =>
                      setMapping((m) => {
                        const next = { ...m };
                        if (a) next[b.id] = a;
                        else delete next[b.id];
                        return next;
                      })
                    }
                  />
                ))}
              </section>
            ) : null}
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('designer.cancel')}
          </Button>
          <Button type="button" disabled={!check?.ok || busy} onClick={() => void publish()}>
            {t('designer.publish.publishVersion', { version: nextVersion })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CheckLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className="flex items-start gap-2" data-ok={ok}>
      <span aria-hidden className={ok ? 'text-emerald-700' : 'text-red-700'}>
        {ok ? '✓' : '✕'}
      </span>
      <span>
        <span className="sr-only">{ok ? '✓ ' : '✕ '}</span>
        {text}
      </span>
    </li>
  );
}

function MappingRow({
  change,
  action,
  variables,
  problems,
  onChange,
}: {
  change: BreakingChange;
  action: MappingAction | undefined;
  variables: ReturnType<typeof variablesOf>;
  problems: string[];
  onChange(a: MappingAction | undefined): void;
}) {
  const { t } = useTranslation();
  const current = variables.find((v) => v.name === change.variable);
  return (
    <fieldset
      className="flex flex-col gap-2 rounded-md border border-slate-200 p-3"
      data-testid="mapping"
    >
      <legend className="px-1 font-medium">
        <span className="font-mono">{change.variable}</span> —{' '}
        {t(`designer.publish.kind.${change.kind}`, {
          codes: (change.removedCodes ?? []).join(', '),
        })}
      </legend>
      <div className="flex flex-wrap gap-4">
        {change.allowed.map((a) => (
          <label key={a} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`map-${change.id}`}
              checked={action?.action === a}
              onChange={() =>
                onChange(
                  a === 'drop'
                    ? { action: 'drop' }
                    : a === 'rename'
                      ? { action: 'rename', to: '' }
                      : {
                          action: 'recode',
                          map: Object.fromEntries(
                            (change.removedCodes ?? []).map((c) => [String(c), null]),
                          ),
                        },
                )
              }
            />
            {t(`designer.publish.action.${a}`)}
          </label>
        ))}
      </div>
      {action?.action === 'rename' ? (
        <label className="flex items-center gap-2">
          <span>{t('designer.publish.renameTo')}</span>
          <select
            className={`${controlCls} w-auto`}
            value={action.to}
            onChange={(e) => onChange({ action: 'rename', to: e.target.value })}
          >
            <option value="">{t('designer.cond.pick')}</option>
            {variables.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {action?.action === 'recode' ? (
        <table className="w-auto text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-600">
              <th scope="col" className="pr-4 font-medium">
                {t('designer.publish.oldCode')}
              </th>
              <th scope="col" className="font-medium">
                {t('designer.publish.newCode')}
              </th>
            </tr>
          </thead>
          <tbody>
            {(change.removedCodes ?? []).map((c) => (
              <tr key={String(c)}>
                <td className="pr-4 font-mono">{String(c)}</td>
                <td>
                  <select
                    className={`${controlCls} w-auto`}
                    aria-label={t('designer.publish.newCodeFor', { code: String(c) })}
                    value={action.map[String(c)] === null ? '' : String(action.map[String(c)])}
                    onChange={(e) =>
                      onChange({
                        action: 'recode',
                        map: {
                          ...action.map,
                          [String(c)]: e.target.value === '' ? null : toLiteral(e.target.value),
                        },
                      })
                    }
                  >
                    <option value="">{t('designer.publish.discard')}</option>
                    {(current?.codes ?? []).map((nc) => (
                      <option key={String(nc.code)} value={String(nc.code)}>
                        {nc.code} · {nc.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {problems.length ? (
        <ul className="text-xs text-red-800">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}
