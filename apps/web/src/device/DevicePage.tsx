import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { FoldedHelp, smallBtn } from '../designer/fields.js';
import { InfoTip } from '../cases/samplingControls.js';
import { dateTime, locale } from '../format.js';
import { dispositionLabel, useNote } from '../i18n-messages.js';
import {
  deviceState,
  downloadCases,
  isOffline,
  noteCaseDetails,
  rememberProject,
  returnCases,
  startOnDevice,
  syncDevice,
} from '../interview/device.js';
import type { DeviceCase } from '../interview/store.js';
import { ShowMoreButton, useShowMore } from '../routes/ShowMore.js';
import { Button, Card, MoreMenu, PageHeader } from '../routes/ui.js';
import { CloudIcon, tone, useOnline } from './status.js';

interface CaseRow {
  id: string;
  externalId: string;
  status: string;
  sample: Record<string, unknown>;
  checkedOutAt: string | null;
  priority: number;
  assignedAt?: string | null;
}

const SYNC_EVERY_MS = 30_000;
/** A last sync older than this is pointed out: work may be waiting and cases may change. */
const STALE_SYNC_HOURS = 24;

/** How long ago, in the interface language ("2 days ago"). */
function ago(language: string, at: string, now = Date.now()) {
  const hours = Math.round((now - Date.parse(at)) / 3_600_000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  return hours < 48 ? rtf.format(-hours, 'hour') : rtf.format(-Math.round(hours / 24), 'day');
}

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
}

const place = (c: { sample?: Record<string, unknown>; context?: Record<string, unknown> }) => {
  const sample = c.sample ?? (c.context?.case as Record<string, unknown> | undefined) ?? {};
  return [sample.city, sample.district, sample.region]
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .join(', ');
};

/**
 * Offline work on this device (D1–D3): download cases, interview with no connection, and send
 * everything back when online (automatically, or with "Sync now"). Works from the device's
 * own copy when there is no connection.
 */
export function DevicePage() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const search = useSearch({ strict: false }) as { notice?: string };
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const online = useOnline();
  const [state, setState] = useState<Awaited<ReturnType<typeof deviceState>> | null>(null);
  const [message, setMessage] = useNote(
    search.notice === 'queued' ? { key: 'device.notice.queued' } : null,
  );
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const install = useRef<InstallPrompt | null>(null);
  const [canInstall, setCanInstall] = useState(false);

  // The clock for deadlines and the stale-sync warning, moved on each minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => setState(await deviceState(projectId)), [projectId]);

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<{ name: string }>(`/projects/${projectId}`),
    enabled: online,
  });
  useEffect(() => {
    if (project.data) void rememberProject(projectId, project.data.name);
  }, [project.data, projectId]);

  const mine = useQuery({
    queryKey: ['device-candidates', projectId],
    queryFn: () =>
      api<{ rows: CaseRow[]; caseExpiryHours?: number | null }>(
        `/projects/${projectId}/cases?assignedTo=me&limit=200`,
      ),
    enabled: online,
  });

  // The deadline and priority of the cases on this device, kept for when there is no connection.
  useEffect(() => {
    const data = mine.data;
    if (!data || !state?.cases.length) return;
    const hours = data.caseExpiryHours;
    const details = state.cases.flatMap((c) => {
      const row = data.rows.find((r) => r.id === c.caseId);
      if (!row) return [];
      const dueAt =
        hours && row.assignedAt
          ? new Date(Date.parse(row.assignedAt) + hours * 3_600_000).toISOString()
          : null;
      return c.dueAt === dueAt && c.priority === row.priority
        ? []
        : [{ caseId: c.caseId, dueAt, priority: row.priority }];
    });
    if (details.length) void noteCaseDetails(details).then(refresh, () => undefined);
  }, [mine.data, state, refresh]);

  const sync = useCallback(
    async (manual = false) => {
      if (!navigator.onLine) return;
      setBusy(true);
      try {
        const r = await syncDevice(projectId);
        if (manual || r.submitted || r.checkedIn)
          setMessage({
            key: 'device.synced',
            vars: { submitted: r.submitted, checkedIn: r.checkedIn },
          });
        await mine.refetch();
      } catch (e) {
        if (manual) setMessage(isOffline(e) ? { key: 'device.syncFailed' } : { error: e });
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [projectId, refresh, mine, setMessage],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Automatic sync: on arrival, every 30 s, and when the connection comes back.
  const latest = useRef(sync);
  latest.current = sync;
  useEffect(() => {
    void latest.current();
    const timer = setInterval(() => void latest.current(), SYNC_EVERY_MS);
    const back = () => void latest.current();
    window.addEventListener('online', back);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', back);
    };
  }, [projectId]);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      install.current = e as InstallPrompt;
      setCanInstall(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const onDevice = new Set(state?.cases.map((c) => c.caseId));
  const candidates = (mine.data?.rows ?? []).filter(
    (r) => (r.status === 'assigned' || r.status === 'in_progress') && !onDevice.has(r.id),
  );
  // A long list of cases to take comes in blocks of 20.
  const more = useShowMore(candidates.length);

  const download = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await downloadCases(projectId, [...picked]);
      setMessage({
        parts: [
          { key: 'device.downloaded', vars: { count: r.downloaded } },
          ...r.refused.map((x) => ({
            key: 'device.refused',
            vars: {
              id: mine.data?.rows.find((m) => m.id === x.caseId)?.externalId ?? x.caseId,
              reason: { key: `device.reasons.${x.code}`, vars: { defaultValue: x.code } },
            },
          })),
        ],
      });
      setPicked(new Set());
      await mine.refetch();
    } catch (e) {
      setMessage({ error: e });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const open = async (c: DeviceCase) => {
    try {
      const id = await startOnDevice(c.caseId);
      await navigate({
        to: '/projects/$projectId/interviews/$interviewId',
        params: { projectId, interviewId: id },
      });
    } catch (e) {
      setMessage({ error: e });
    }
  };

  const giveBack = async (c: DeviceCase) => {
    setBusy(true);
    try {
      await returnCases(projectId, [c.caseId]);
      await mine.refetch();
    } catch (e) {
      setMessage({ error: e });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const name = project.data?.name ?? state?.projectName ?? '';
  const gps = state?.cases.find((c) => c.capi.gps === 'start_end')?.capi;
  const waiting = state?.waiting ?? 0;
  const held = state?.cases.length ?? 0;
  const stale =
    (waiting > 0 || held > 0) &&
    !!state?.lastSync &&
    now - Date.parse(state.lastSync) > STALE_SYNC_HOURS * 3_600_000;

  return (
    <div className="flex flex-col gap-4" data-testid="device">
      <PageHeader
        parents={[
          <Link
            key="projects"
            to="/projects"
            activeOptions={{ exact: true }}
            className="hover:underline"
          >
            {t('designer.projects')}
          </Link>,
          ...(name
            ? [
                <Link
                  key="project"
                  to="/projects/$projectId"
                  params={{ projectId }}
                  activeOptions={{ exact: true }}
                  className="hover:underline"
                >
                  {name}
                </Link>,
              ]
            : []),
        ]}
        title={<span aria-current="page">{t('device.title')}</span>}
        actions={
          canInstall ? (
            <button
              type="button"
              className={smallBtn}
              onClick={() => {
                void install.current?.prompt();
                setCanInstall(false);
              }}
            >
              {t('device.install')}
            </button>
          ) : null
        }
      />

      <section
        aria-labelledby="device-sync"
        data-testid="sync-card"
        className={`flex flex-wrap items-center gap-x-8 gap-y-2 rounded-xl border px-4 py-2.5 ${tone(online, waiting)}`}
      >
        <h2 id="device-sync" className="sr-only">
          {t('device.statusTitle')}
        </h2>
        <div className="flex items-center gap-3">
          <CloudIcon online={online} className="h-7 w-7" />
          <div className="flex flex-col">
            <span data-testid="connection" data-online={online} className="font-semibold">
              {online ? t('device.online') : t('device.offline')}
            </span>
            <span className="text-xs">
              {state?.lastSync
                ? t('device.lastSync', {
                    time: new Date(state.lastSync).toLocaleString(locale(i18n.language)),
                  })
                : t('device.never')}
            </span>
          </div>
        </div>
        <p className="flex items-baseline gap-2" data-testid="waiting" data-count={waiting}>
          <span className="text-2xl font-bold tabular-nums">{waiting}</span>
          <span className="text-sm font-medium">{t('device.toSendLabel', { count: waiting })}</span>
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            type="button"
            size="sm"
            disabled={!online || busy}
            aria-describedby={online ? undefined : 'sync-unavailable'}
            onClick={() => void sync(true)}
          >
            {busy ? t('device.syncing') : t('device.syncNow')}
          </Button>
          {online ? null : (
            <span id="sync-unavailable" className="text-xs">
              {t('device.syncUnavailable')}
            </span>
          )}
        </div>
        {stale ? (
          <p className="basis-full font-medium" data-testid="stale-sync">
            {t('device.stale', { age: ago(i18n.language, state!.lastSync!, now) })}
          </p>
        ) : null}
      </section>
      <p
        role="status"
        aria-live="polite"
        className="empty:hidden text-sm"
        data-testid="device-message"
      >
        {message}
      </p>
      {state?.closed.map((n) => (
        <section
          key={n.projectId}
          aria-labelledby={`closed-${n.projectId}`}
          data-testid="project-closed"
          data-project={n.projectId}
          data-kept={n.kept}
          className={`rounded-md border-l-4 px-3 py-2 text-sm ${n.kept ? 'border-amber-500 bg-amber-50 text-amber-ink-900' : 'border-slate-400 bg-slate-50 text-slate-800'}`}
        >
          <h2 id={`closed-${n.projectId}`} className="font-semibold">
            {t('device.closed.title')}
          </h2>
          <p>
            {(() => {
              const vars = {
                name: n.name ?? t('device.closed.unnamed'),
                date: new Date(n.at).toLocaleString(i18n.language),
              };
              if (n.kept) return t('device.closed.kept', { ...vars, count: n.kept });
              return n.removed
                ? t('device.closed.removed', { ...vars, count: n.removed })
                : t('device.closed.removedNone', vars);
            })()}
          </p>
        </section>
      ))}
      {gps ? (
        <p className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-ink-900">
          <strong>{t('device.gpsTitle')}:</strong> {t('device.gpsOn')}. {gps.gpsNotice}
        </p>
      ) : null}

      <Card>
        <section aria-labelledby="device-cases" className="flex flex-col gap-2">
          <h2 id="device-cases" className="text-lg font-semibold">
            {t('device.onDevice')}
          </h2>
          {state?.cases.length ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="device-cases">
                  <thead className="text-left text-slate-600">
                    <tr>
                      <th scope="col">{t('device.case')}</th>
                      <th scope="col">{t('device.place')}</th>
                      <th scope="col">{t('device.priority')}</th>
                      <th scope="col">{t('device.due')}</th>
                      <th scope="col">{t('device.state')}</th>
                      <th scope="col" className="text-right">
                        {t('device.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {state.cases.map((c) => (
                      <tr key={c.caseId} data-case={c.externalId} data-status={c.status}>
                        <td className="whitespace-nowrap py-1.5 font-medium">{c.externalId}</td>
                        <td>{place(c)}</td>
                        <td>{c.priority ?? '—'}</td>
                        <td data-testid="due">
                          {c.dueAt === undefined ? (
                            '—'
                          ) : c.dueAt === null ? (
                            <span className="text-slate-600">{t('device.noDue')}</span>
                          ) : Date.parse(c.dueAt) < now ? (
                            <span className="font-medium text-red-ink-800">
                              {t('device.overdue', { date: dateTime(c.dueAt) })}
                            </span>
                          ) : (
                            dateTime(c.dueAt)
                          )}
                        </td>
                        <td>
                          {t(`device.status.${c.status}`)}
                          {c.disposition && c.status !== 'started'
                            ? ` · ${dispositionLabel(t, c.disposition)}`
                            : ''}
                          {c.problem ? (
                            <span className="block text-red-ink-800">
                              {t(`device.problems.${c.problem}`, { defaultValue: c.problem })}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-1">
                          <div className="flex items-center justify-end gap-2">
                            {c.status === 'ready' || c.status === 'started' ? (
                              <button
                                type="button"
                                className={smallBtn}
                                onClick={() => void open(c)}
                              >
                                {c.status === 'ready' ? t('device.start') : t('device.continue')}
                                <span className="sr-only"> {c.externalId}</span>
                              </button>
                            ) : null}
                            {c.status === 'ready' && online ? (
                              <MoreMenu
                                label={t('device.caseActions', { id: c.externalId })}
                                entries={[
                                  {
                                    type: 'item',
                                    id: 'return',
                                    label: t('device.returnCase', { id: c.externalId }),
                                    disabled: busy,
                                    onSelect: () => void giveBack(c),
                                  },
                                ]}
                              />
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="flex items-center text-xs text-slate-700" data-testid="device-privacy">
                {t('device.privacyShort')}
                <InfoTip
                  id="device-privacy"
                  term={t('device.privacyShort')}
                  text={t('device.privacy')}
                  align="start"
                />
              </p>
            </>
          ) : (
            <p className="text-slate-600">{t('device.empty')}</p>
          )}
        </section>
      </Card>
      <Card>
        <section aria-labelledby="device-download" className="flex flex-col gap-2">
          <h2 id="device-download" className="text-lg font-semibold">
            {t('device.download')}
          </h2>
          {!online ? (
            <p className="text-slate-700">{t('device.needsConnection')}</p>
          ) : candidates.length ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void download();
              }}
            >
              <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3" data-testid="download-list">
                {candidates.slice(0, more.shown).map((r) => (
                  <li key={r.id}>
                    <label className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm">
                      <input
                        type="checkbox"
                        aria-label={t('device.select', { id: r.externalId })}
                        checked={picked.has(r.id)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          setPicked(next);
                        }}
                      />
                      <span className="font-medium">{r.externalId}</span>
                      <span className="text-slate-600">{place(r)}</span>
                      {r.checkedOutAt ? (
                        <span className="text-xs text-amber-ink-800">
                          ({t('device.elsewhere')})
                        </span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
              <ShowMoreButton more={more} />
              <div>
                <Button type="submit" disabled={busy || !picked.size}>
                  {t('device.downloadSelected')}
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-slate-600">{t('device.noneToDownload')}</p>
          )}
          <FoldedHelp>{t('device.downloadHelp')}</FoldedHelp>
        </section>
      </Card>
    </div>
  );
}
