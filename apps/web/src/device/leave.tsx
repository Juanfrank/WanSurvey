import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../designer/Dialog.js';
import { localiseError } from '../i18n-messages.js';
import { clearDevice, deviceSummary } from '../interview/device.js';
import { Button } from '../routes/ui.js';

type Held = Awaited<ReturnType<typeof deviceSummary>>;

/**
 * Before signing out, says what stays on this device: interviews not yet sent are kept (and
 * never removed from here), and downloaded cases, which carry personal data, can be given back
 * and removed. Resolves whether to go on signing out; with nothing on the device, at once.
 */
export function confirmSignOut(): Promise<boolean> {
  // A second click while the question is open gets the same answer, not a second dialog.
  asking ??= ask().finally(() => {
    asking = null;
  });
  return asking;
}

let asking: Promise<boolean> | null = null;

async function ask(): Promise<boolean> {
  let held: Held;
  try {
    held = await deviceSummary();
  } catch {
    // No offline storage on this browser: nothing kept.
    return true;
  }
  if (!held.unsent && !held.recordings && !held.cases) return true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return new Promise<boolean>((resolve) => {
    const finish = (go: boolean) => {
      root.unmount();
      host.remove();
      resolve(go);
    };
    root.render(<LeaveDialog held={held} onDone={finish} />);
  });
}

function LeaveDialog({ held, onDone }: { held: Held; onDone(go: boolean): void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const online = navigator.onLine;
  const waiting = held.unsent > 0 || held.recordings > 0;
  const canClear = !waiting && online;

  const clear = async () => {
    setBusy(true);
    setError('');
    try {
      await clearDevice();
      onDone(true);
    } catch (e) {
      setError(localiseError(t, e));
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('device.leave.title')} onClose={() => onDone(false)}>
      <div className="flex flex-col gap-3 text-sm" data-testid="leave-device">
        {held.unsent ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-ink-900">
            {t('device.leave.unsent', { count: held.unsent })}
          </p>
        ) : null}
        {held.recordings ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-ink-900">
            {t('device.leave.recordings')}
          </p>
        ) : null}
        {held.cases ? <p>{t('device.leave.cases', { count: held.cases })}</p> : null}
        {held.cases && !waiting ? (
          <p className="text-slate-700">
            {online ? t('device.leave.clearHelp') : t('device.leave.offlineHelp')}
          </p>
        ) : null}
        <p role="alert" className="text-red-ink-800 empty:hidden">
          {error}
        </p>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => onDone(false)}>
            {t('device.leave.cancel')}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => onDone(true)}>
            {waiting ? t('device.leave.signOutAnyway') : t('device.leave.keep')}
          </Button>
          {canClear && held.cases ? (
            <Button type="button" disabled={busy} onClick={() => void clear()}>
              {busy ? t('device.leave.clearing') : t('device.leave.clear')}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
