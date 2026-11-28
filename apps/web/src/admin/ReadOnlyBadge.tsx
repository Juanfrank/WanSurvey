import { useTranslation } from 'react-i18next';
import { InfoTip } from '../cases/samplingControls.js';
import { Badge } from '../routes/ui.js';

/**
 * "Read only", in the page header of whoever may see a list but not change it; its (i) says
 * who changes it. Pass it as the PageHeader's `actions` in place of the page's button.
 */
export function ReadOnlyBadge({ id, text }: { id: string; text: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-0.5" data-read-only="">
      <Badge>{t('admin.readOnly')}</Badge>
      <InfoTip id={id} term={t('admin.readOnly')} text={text} align="start" />
    </span>
  );
}
