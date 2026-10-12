import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { useMe } from './AppLayout.js';
import { Button, Card } from './ui.js';

/** Shown to people who can sign in but have no role yet (e.g. after a first Microsoft sign-in). */
export function WaitingPage() {
  const { t } = useTranslation();
  const me = useMe();
  const queryClient = useQueryClient();
  if (!me.data) return null;
  const others = me.data.tenants.filter((tn) => tn.id !== me.data!.tenantId);
  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <h1 className="mb-3 text-xl font-semibold">{t('waiting.title')}</h1>
        <p className="mb-3 text-slate-800" data-testid="access-message">
          {me.data.access.message}
        </p>
        <p className="text-sm text-slate-600">{t('waiting.explain')}</p>
        {others.length ? (
          <div className="mt-5">
            <p className="mb-2 text-sm font-medium">{t('waiting.otherOrgs')}</p>
            <ul className="flex flex-col gap-2">
              {others.map((tn) => (
                <li key={tn.id} className="flex items-center justify-between gap-3">
                  <span>{tn.name}</span>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      await api('/auth/switch-tenant', {
                        method: 'POST',
                        body: { tenantId: tn.id },
                      });
                      await queryClient.invalidateQueries();
                    }}
                  >
                    {t('waiting.switch')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
