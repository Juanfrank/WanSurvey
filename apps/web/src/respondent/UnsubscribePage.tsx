import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Shell } from './RespondentPage.js';
import { respondentText } from './text.js';

/** Unsubscribe from a survey's e-mails (`/u/$token`), with one confirmation. */
export function UnsubscribePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const t = respondentText(navigator.language);
  const [info, setInfo] = useState<{ email: string | null; unsubscribed: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<{ email: string | null; unsubscribed: boolean }>(`/public/u/${token}`).then(setInfo, () =>
      setFailed(true),
    );
  }, [token]);

  return (
    <Shell title={t.unsubscribeTitle}>
      {failed ? (
        <p role="alert">{t.notFound}</p>
      ) : !info ? (
        <p aria-busy="true">{t.loading}</p>
      ) : info.unsubscribed ? (
        <p role="status">{t.unsubscribed}</p>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p>{t.unsubscribeText.replace('{email}', info.email ?? '')}</p>
          <button
            type="button"
            className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white"
            onClick={() =>
              void api<{ email: string | null; unsubscribed: boolean }>(`/public/u/${token}`, {
                method: 'POST',
              }).then(setInfo, () => setFailed(true))
            }
          >
            {t.unsubscribeButton}
          </button>
        </div>
      )}
    </Shell>
  );
}
