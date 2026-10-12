import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Map as LeafletMap } from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { localiseError } from '../i18n-messages.js';

interface Point {
  caseId: string;
  externalId: string;
  status: string;
  lat: number;
  lng: number;
  quality: string | null;
}

interface GeoStatus {
  enabled: boolean;
  job: {
    running: boolean;
    total: number;
    done: number;
    found: number;
    notFound: number;
    failed: number;
  } | null;
}

const STATUS_COLOUR: Record<string, string> = {
  fresh: '#475569',
  assigned: '#4338ca',
  in_progress: '#b45309',
  finalised: '#047857',
  withdrawn: '#b91c1c',
};

/**
 * Geocoded cases on an OpenStreetMap map, plus the same points as a table for keyboard and
 * screen-reader users. Points carry case ids only; addresses stay in the case drawer.
 */
export function CaseMap({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen(caseId: string): void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canGeocode = useCan('cases.edit', projectId);
  const canStatus = useCan('cases.read_all', projectId) || canGeocode;
  const [message, setMessage] = useState('');
  const points = useQuery({
    queryKey: ['cases-map', projectId],
    queryFn: () => api<Point[]>(`/projects/${projectId}/cases-map`),
  });
  const status = useQuery({
    queryKey: ['geocode-status', projectId],
    queryFn: () => api<GeoStatus>(`/projects/${projectId}/geocode/status`),
    enabled: canStatus,
    refetchInterval: (q) => (q.state.data?.job?.running ? 1000 : false),
  });
  const running = !!status.data?.job?.running;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running)
      void qc.invalidateQueries({ queryKey: ['cases-map', projectId] });
    wasRunning.current = running;
  }, [running, qc, projectId]);
  const start = useMutation({
    mutationFn: () => api(`/projects/${projectId}/geocode`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      setMessage('');
      await qc.invalidateQueries({ queryKey: ['geocode-status', projectId] });
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });

  // Leaflet is loaded only when the map is shown.
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const [mapError, setMapError] = useState(false);
  const data = points.data ?? [];
  useEffect(() => {
    if (!box.current || !data.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const L = (await import('leaflet')).default;
        await import('leaflet/dist/leaflet.css');
        if (cancelled || !box.current) return;
        map.current?.remove();
        const m = L.map(box.current, { keyboard: true });
        map.current = m;
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '© OpenStreetMap contributors',
        }).addTo(m);
        const bounds = L.latLngBounds(data.map((p) => [p.lat, p.lng] as [number, number]));
        for (const p of data)
          L.circleMarker([p.lat, p.lng], {
            radius: 6,
            color: STATUS_COLOUR[p.status] ?? '#334155',
            weight: 2,
            fillOpacity: 0.7,
          })
            .bindTooltip(`${p.externalId} · ${t(`cases.status.${p.status}`)}`)
            .on('click', () => onOpen(p.caseId))
            .addTo(m);
        m.fitBounds(bounds.pad(0.2), { maxZoom: 16 });
      } catch {
        setMapError(true);
      }
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, [data, onOpen, t]);

  const job = status.data?.job;
  return (
    <section aria-labelledby="map-h" className="flex flex-col gap-3" data-testid="case-map">
      <h2 id="map-h" className="sr-only">
        {t('cases.map.title')}
      </h2>
      {canStatus ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {status.data && !status.data.enabled ? (
            <p className="text-slate-600">{t('cases.map.off')}</p>
          ) : canGeocode ? (
            <button
              type="button"
              className={smallBtn}
              disabled={running || start.isPending}
              onClick={() => start.mutate()}
            >
              {t('cases.map.geocode')}
            </button>
          ) : null}
          <p role="status" aria-live="polite" data-testid="geocode-status">
            {job
              ? running
                ? t('cases.map.running', { done: job.done, total: job.total })
                : t('cases.map.done', {
                    found: job.found,
                    notFound: job.notFound,
                    failed: job.failed,
                  })
              : ''}
            {message}
          </p>
        </div>
      ) : null}
      {status.data?.enabled ? (
        <p className="text-xs text-slate-600">{t('cases.map.privacy')}</p>
      ) : null}
      {data.length ? (
        <>
          {mapError ? (
            <p className="text-sm text-slate-600">{t('cases.map.unavailable')}</p>
          ) : (
            <div
              ref={box}
              className="h-96 w-full rounded-md border border-slate-200"
              role="region"
              aria-label={t('cases.map.region', { count: data.length })}
            />
          )}
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              {t('cases.map.asTable', { count: data.length })}
            </summary>
            <table className="mt-2 w-full text-sm" data-testid="map-points">
              <thead className="text-left text-xs text-slate-600">
                <tr>
                  <th scope="col">{t('cases.list.col.externalId')}</th>
                  <th scope="col">{t('cases.list.col.status')}</th>
                  <th scope="col">{t('cases.map.coordinates')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.map((p) => (
                  <tr key={`${p.caseId}:${p.lat}:${p.lng}`}>
                    <td className="py-1">
                      <button
                        type="button"
                        className="font-mono text-indigo-700 underline-offset-2 hover:underline"
                        onClick={() => onOpen(p.caseId)}
                      >
                        {p.externalId}
                      </button>
                    </td>
                    <td>{t(`cases.status.${p.status}`)}</td>
                    <td className="font-mono text-xs">
                      {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <p className="text-sm text-slate-600">{t('cases.map.none')}</p>
      )}
    </section>
  );
}
