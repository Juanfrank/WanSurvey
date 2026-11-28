import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { permKey } from '../admin/permissions.js';
import { inputCls } from '../designer/fields.js';

/**
 * The warning and the reason asked before giving an external client access to interviews,
 * recordings or personal data (Users' roles and invitation, a project's People).
 */
export function ExternalReason({
  opens,
  reason,
  onReason,
}: {
  opens: readonly string[];
  reason: string;
  onReason(v: string): void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const shown = opens.length > 0;
  // It appears at the end of the dialog's scrolling body, often under its footer: bring the
  // whole of it, the reason's field included, into view when it appears or what it lists
  // changes (the rows above it change too then). The scroll margin keeps it clear of a footer
  // that sticks to the bottom of that body.
  const what = opens.join(' ');
  useEffect(() => {
    if (what) box.current?.scrollIntoView?.({ block: 'end' });
  }, [what]);
  if (!shown) return null;
  return (
    <div
      ref={box}
      role="alert"
      className="flex scroll-mb-24 flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-ink-900"
      data-testid="external-warning"
    >
      <p className="font-medium">{t('team.projectPeople.externalWarning')}</p>
      <ul className="ml-5 list-disc">
        {opens.map((p) => (
          <li key={p}>{t(permKey(p))}</li>
        ))}
      </ul>
      <label className="flex flex-col gap-1 font-medium text-slate-800">
        {t('team.projectPeople.reason')}
        <textarea
          className={`${inputCls} min-h-[3rem] font-normal`}
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          // The browser brings a focused field into the scrolling body, not above its footer.
          onFocus={() => box.current?.scrollIntoView?.({ block: 'end' })}
        />
      </label>
    </div>
  );
}
