import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';

const CATEGORIES = ['callbacks', 'assignments', 'returned', 'exports'] as const;
type Category = (typeof CATEGORIES)[number];

const supported = () =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window !== 'undefined' &&
  'PushManager' in window &&
  'Notification' in window;

const keyBytes = (b64u: string) => {
  const pad = '='.repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob((b64u + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const b64u = (buf: ArrayBuffer | null) =>
  buf
    ? btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    : '';

/**
 * Web notifications for this browser (ADR 0001, decision 6), chosen by category in the account
 * menu: nothing is asked of the browser until the person ticks one. Hidden where the browser
 * cannot do it or the server has no keys.
 */
export function Notifications() {
  const { t, i18n } = useTranslation();
  const config = useQuery({
    queryKey: ['push-config'],
    queryFn: () => api<{ enabled: boolean; publicKey: string | null }>('/push/config'),
    enabled: supported(),
    staleTime: 3_600_000,
  });
  const [chosen, setChosen] = useState<Category[]>([]);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!supported()) return;
    setDenied(Notification.permission === 'denied');
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return setChosen([]);
    const s = await api<{ subscribed: boolean; categories: Category[] }>(
      `/push/subscription?endpoint=${encodeURIComponent(sub.endpoint)}`,
    );
    setChosen(s.subscribed ? s.categories : []);
  }, []);
  useEffect(() => {
    if (config.data?.enabled) void load().catch(() => undefined);
  }, [config.data?.enabled, load]);

  if (!supported() || !config.data?.enabled) return null;

  const save = async (next: Category[]) => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!next.length) {
        if (sub) {
          await api('/push/subscription', { method: 'DELETE', body: { endpoint: sub.endpoint } });
          await sub.unsubscribe();
        }
        return setChosen([]);
      }
      if (!sub) {
        if ((await Notification.requestPermission()) !== 'granted') return setDenied(true);
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(config.data!.publicKey!),
        });
      }
      await api('/push/subscription', {
        method: 'PUT',
        body: {
          endpoint: sub.endpoint,
          keys: { p256dh: b64u(sub.getKey('p256dh')), auth: b64u(sub.getKey('auth')) },
          categories: next,
          lang: i18n.resolvedLanguage ?? 'es',
        },
      });
      setChosen(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="flex flex-col gap-1.5" data-testid="notifications" disabled={busy}>
      <legend className="eyebrow mb-1">{t('app.notifications.title')}</legend>
      {denied ? <p className="text-xs text-slate-600">{t('app.notifications.denied')}</p> : null}
      {CATEGORIES.map((c) => (
        <label key={c} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={chosen.includes(c)}
            onChange={(e) =>
              void save(e.target.checked ? [...chosen, c] : chosen.filter((x) => x !== c))
            }
          />
          {t(`app.notifications.categories.${c}`)}
        </label>
      ))}
      {chosen.length ? (
        <button
          type="button"
          className="self-start text-xs text-indigo-ink-700 underline"
          onClick={() => void api('/push/test', { method: 'POST' })}
        >
          {t('app.notifications.test')}
        </button>
      ) : null}
    </fieldset>
  );
}
