import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { switchTenant } from '../api.js';
import { useMe } from './AppLayout.js';
import { Button, Card } from './ui.js';

/** Shown to people who can sign in but have no role yet (e.g. after a first Microsoft sign-in). */
export function WaitingPage() {
  const { t } = useTranslation();
  const me = useMe();
  const queryClient = useQueryClient();
  if (!me.data) return null;
  const others = me.data.tenants.filter((tn) => tn.id !== me.data!.tenantId);
  const org = me.data.tenants.find((tn) => tn.id === me.data!.tenantId)?.name;
  // Said in the interface's language (the server's message is in English): with the
  // organisation's name when it is known, else the server's words.
  const message =
    me.data.access.state === 'no_role' && org
      ? t('waiting.noRole', { org })
      : me.data.access.message;
  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <h1 className="mb-3 text-xl font-semibold">{t('waiting.title')}</h1>
        <p className="text-slate-800" data-testid="access-message">
          {message}
        </p>
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
                      if (await switchTenant(tn.id)) await queryClient.invalidateQueries();
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
