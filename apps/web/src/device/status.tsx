import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deviceState } from '../interview/device.js';

/** Whether the browser has a connection, kept current. */
export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** A cloud, crossed out with no connection. Decorative: the text beside it says the state. */
export function CloudIcon({ online, className }: { online: boolean; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`flex-none ${className}`}
    >
      <path d="M17.5 19H7a5 5 0 1 1 1.6-9.74A6 6 0 0 1 20 11.5a3.75 3.75 0 0 1-2.5 7.5Z" />
      {online ? <path d="m9 14 2 2 4-4" /> : <path d="M3 3l18 18" />}
    </svg>
  );
}

/** The colours of a sync state: no connection, something waiting, everything sent. */
export const tone = (online: boolean, waiting: number) =>
  !online
    ? 'border-amber-300 bg-amber-50 text-amber-ink-900'
    : waiting
      ? 'border-sky-300 bg-sky-50 text-sky-ink-900'
      : 'border-emerald-300 bg-emerald-50 text-emerald-ink-900';

const POLL_MS = 15_000;

/**
 * The way to the device page, with the state beside it (not in its name): connection, and how
 * many interviews and cases this device holds for the project. Kept current while shown.
 */
export function DeviceStatusLink({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const online = useOnline();
  const [held, setHeld] = useState<{ waiting: number; cases: number } | null>(null);

  useEffect(() => {
    let live = true;
    const read = () => {
      deviceState(projectId).then(
        (s) => {
          if (live) setHeld({ waiting: s.waiting, cases: s.cases.length });
        },
        // No offline storage: the connection is still worth showing.
        () => undefined,
      );
    };
    read();
    const timer = setInterval(read, POLL_MS);
    window.addEventListener('online', read);
    window.addEventListener('offline', read);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('online', read);
      window.removeEventListener('offline', read);
    };
  }, [projectId]);

  const waiting = held?.waiting ?? 0;
  // Until the device is read (or when it cannot be), only the connection is said: never "0 to send".
  const parts = held
    ? [
        online ? t('device.online') : t('device.offline'),
        t('device.toSend', { count: waiting }),
        ...(held.cases ? [t('device.casesHere', { count: held.cases })] : []),
      ]
    : [online ? t('device.online') : t('device.offline')];
  return (
    // Small, so that on a project it fits on the breadcrumb's line beside the account.
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <Link
        to="/projects/$projectId/device"
        params={{ projectId }}
        className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-2 py-1 font-medium hover:bg-slate-50"
      >
        {t('device.link')}
      </Link>
      <span
        data-testid="device-indicator"
        data-online={online}
        data-waiting={held ? waiting : undefined}
        title={t('device.indicatorTitle')}
        className={`flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-medium ${held || !online ? tone(online, waiting) : 'border-slate-300 bg-white text-slate-700'}`}
      >
        <CloudIcon online={online} className="h-3.5 w-3.5" />
        {parts.join(' · ')}
      </span>
    </div>
  );
}
