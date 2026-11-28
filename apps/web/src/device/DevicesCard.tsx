import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { ago } from '../interview/side.js';
import { Badge, Card, numCls, tableCls, tdCls, thCls, TableScroll } from '../routes/ui.js';

/** After this long without a sync, a device holding cases is flagged (as on the device page). */
const STALE_SYNC_HOURS = 24;

interface DeviceRow {
  userId: string;
  name: string;
  cases: number;
  devices: number;
  checkedOutAt: string | null;
  lastSync: string | null;
}

/**
 * For supervisors, on the live dashboard (169): how many cases each interviewer holds on a
 * device and when their devices last synchronised; long silences with cases on board first.
 */
export function DevicesCard({ projectId, at }: { projectId: string; at: string }) {
  const { t, i18n } = useTranslation();
  // Re-read at most once a minute, following the snapshots.
  const rows = useQuery({
    queryKey: ['capi-devices', projectId, at.slice(0, 16)],
    queryFn: () => api<DeviceRow[]>(`/projects/${projectId}/capi/devices`),
    placeholderData: (prev) => prev,
  });
  if (!rows.data) return null;
  const now = Date.parse(at);
  return (
    <Card className="flex flex-col gap-2">
      <h3 className="font-medium">{t('device.team.title')}</h3>
      {rows.data.length ? (
        <TableScroll label={t('device.team.title')}>
          <table className={tableCls} data-testid="team-devices">
            <thead>
              <tr>
                <th className={thCls}>{t('device.team.who')}</th>
                <th className={`${thCls} ${numCls}`}>{t('device.team.cases')}</th>
                <th className={thCls}>{t('device.team.lastSync')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.data.map((r) => {
                const last = r.lastSync ?? r.checkedOutAt;
                const stale =
                  r.cases > 0 && (!last || now - Date.parse(last) > STALE_SYNC_HOURS * 3_600_000);
                return (
                  <tr key={r.userId} data-user={r.name}>
                    <td className={tdCls}>{r.name}</td>
                    <td className={`${tdCls} ${numCls}`}>
                      {r.cases}
                      {r.devices > 1 ? (
                        <span className="block text-xs text-slate-600">
                          {t('device.team.devices', { count: r.devices })}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdCls}>
                      <span className="mr-2">
                        {last ? ago(i18n.language, last, now) : t('device.never')}
                      </span>
                      {stale ? <Badge tone="warning">{t('device.team.stale')}</Badge> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      ) : (
        <p className="text-slate-600">{t('device.team.none')}</p>
      )}
    </Card>
  );
}
