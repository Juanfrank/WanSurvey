import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from '../api.js';
import { LANGUAGES, setLanguage } from '../i18n.js';
import { ChevronDownIcon, LogoutIcon } from './icons.js';

/** Up to two initials from a person's name, or the first letter of their e-mail. */
export function initialsOf(name: string | null | undefined, email: string) {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length)
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('');
  return (email[0] ?? '?').toUpperCase();
}

/**
 * The account pill at the top right: the person's badge (initials, name, e-mail), which opens
 * their menu (organisation and language), and, next to it, sign out.
 */
export function AccountMenu({
  me,
  onSwitchTenant,
  onSignOut,
}: {
  me: Me;
  onSwitchTenant(tenantId: string): void;
  onSignOut(): void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const name = me.user.name || me.user.email;

  // Closes on a click elsewhere; Escape closes and gives focus back to the badge.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    box.current?.querySelector<HTMLElement>('select')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const field =
    'w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800';

  return (
    <div
      ref={box}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <div className="inline-flex h-11 items-center gap-0.5 rounded-full border border-slate-200 bg-white px-1 shadow-sm">
        <button
          ref={button}
          type="button"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={t('app.account', { name })}
          onClick={() => setOpen(!open)}
          className="flex h-9 min-w-0 items-center gap-2 rounded-full pl-0.5 pr-2 text-left hover:bg-slate-50 aria-expanded:bg-slate-50"
        >
          <span
            aria-hidden="true"
            className="grid h-8 w-8 flex-none place-items-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-600"
          >
            {initialsOf(me.user.name, me.user.email)}
          </span>
          <span className="hidden min-w-0 flex-col leading-tight sm:flex">
            <b className="max-w-48 truncate text-[13px] text-navy">{name}</b>
            <span className="max-w-48 truncate text-[11px] text-slate-600">{me.user.email}</span>
          </span>
          <ChevronDownIcon className="h-4 w-4 text-slate-500" />
        </button>
        <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-slate-200" />
        <button
          type="button"
          aria-label={t('app.signOut')}
          title={t('app.signOut')}
          onClick={onSignOut}
          className="grid h-9 w-9 place-items-center rounded-full text-navy hover:bg-indigo-50 hover:text-indigo-600"
        >
          <LogoutIcon className="h-[18px] w-[18px]" />
        </button>
      </div>
      <div
        id={menuId}
        hidden={!open}
        className="absolute right-0 top-13 z-40 flex w-72 flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-card"
      >
        <div className="leading-tight">
          <p className="truncate font-semibold text-navy">{name}</p>
          <p className="truncate text-xs text-slate-600">{me.user.email}</p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">{t('app.organisation')}</span>
          <select
            className={field}
            value={me.tenantId}
            onChange={(e) => onSwitchTenant(e.target.value)}
          >
            {me.tenants.map((tn) => (
              <option key={tn.id} value={tn.id}>
                {tn.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">{t('app.language')}</span>
          <select
            className={field}
            value={i18n.resolvedLanguage}
            onChange={(e) => void setLanguage(e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
