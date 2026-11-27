import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { smallBtn } from '../designer/fields.js';
import { dateTime } from '../format.js';
import { dispositionLabel, localiseError } from '../i18n-messages.js';
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
import { Button, Card } from '../routes/ui.js';
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
  const [message, setMessage] = useState(
    search.notice === 'queued' ? t('device.notice.queued') : '',
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
          setMessage(t('device.synced', { submitted: r.submitted, checkedIn: r.checkedIn }));
        await mine.refetch();
      } catch (e) {
        if (manual) setMessage(isOffline(e) ? t('device.syncFailed') : localiseError(t, e));
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [projectId, refresh, t, mine],
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

  const download = async () => {
    setBusy(true);
    setMessage('');
    try {
      const r = await downloadCases(projectId, [...picked]);
      const refusedText = r.refused
        .map((x) => {
          const row = mine.data?.rows.find((m) => m.id === x.caseId);
          return t('device.refused', {
            id: row?.externalId ?? x.caseId,
            reason: t(`device.reasons.${x.code}`, { defaultValue: x.code }),
          });
        })
        .join(' ');
      setMessage(`${t('device.downloaded', { count: r.downloaded })} ${refusedText}`.trim());
      setPicked(new Set());
      await mine.refetch();
    } catch (e) {
      setMessage(localiseError(t, e));
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
      setMessage(localiseError(t, e));
    }
  };

  const giveBack = async (c: DeviceCase) => {
    setBusy(true);
    try {
      await returnCases(projectId, [c.caseId]);
      await mine.refetch();
    } catch (e) {
      setMessage(localiseError(t, e));
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
    <div className="flex flex-col gap-6" data-testid="device">
      <nav aria-label={t('designer.breadcrumb')} className="text-sm text-slate-600">
        <Link to="/projects/$projectId" params={{ projectId }} className="hover:underline">
          {name || t('designer.projects')}
        </Link>
      </nav>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-2xl font-bold">{t('device.title')}</h1>
        {canInstall ? (
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
        ) : null}
      </header>

      <section
        aria-labelledby="device-sync"
        data-testid="sync-card"
        className={`flex flex-wrap items-center gap-x-10 gap-y-4 rounded-xl border p-5 ${tone(online, waiting)}`}
      >
        <h2 id="device-sync" className="sr-only">
          {t('device.statusTitle')}
        </h2>
        <div className="flex items-center gap-3">
          <CloudIcon online={online} className="h-10 w-10" />
          <div className="flex flex-col">
            <span data-testid="connection" data-online={online} className="text-lg font-semibold">
              {online ? t('device.online') : t('device.offline')}
            </span>
            <span className="text-sm">
              {state?.lastSync
                ? t('device.lastSync', {
                    time: new Date(state.lastSync).toLocaleString(i18n.language),
                  })
                : t('device.never')}
            </span>
          </div>
        </div>
        <p className="flex items-baseline gap-2" data-testid="waiting" data-count={waiting}>
          <span className="text-4xl font-bold tabular-nums">{waiting}</span>
          <span className="text-sm font-medium">{t('device.toSendLabel', { count: waiting })}</span>
        </p>
        <div className="flex flex-col gap-1">
          <Button
            type="button"
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
                      <th scope="col">{t('device.actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {state.cases.map((c) => (
                      <tr key={c.caseId} data-case={c.externalId} data-status={c.status}>
                        <td className="py-1.5 font-medium">{c.externalId}</td>
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
                        <td className="flex flex-wrap gap-2 py-1">
                          {c.status === 'ready' || c.status === 'started' ? (
                            <button type="button" className={smallBtn} onClick={() => void open(c)}>
                              {c.status === 'ready' ? t('device.start') : t('device.continue')}
                              <span className="sr-only"> {c.externalId}</span>
                            </button>
                          ) : null}
                          {c.status === 'ready' && online ? (
                            <button
                              type="button"
                              className={smallBtn}
                              disabled={busy}
                              onClick={() => void giveBack(c)}
                            >
                              {t('device.return')}
                              <span className="sr-only"> {c.externalId}</span>
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-sm text-slate-700" data-testid="device-privacy">
                {t('device.privacy')}
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
          <p className="text-sm text-slate-600">{t('device.downloadHelp')}</p>
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
                {candidates.map((r) => (
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
              <div>
                <Button type="submit" disabled={busy || !picked.size}>
                  {t('device.downloadSelected')}
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-slate-600">{t('device.noneToDownload')}</p>
          )}
        </section>
      </Card>
    </div>
  );
}
