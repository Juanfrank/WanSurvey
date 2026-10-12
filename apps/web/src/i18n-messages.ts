import type { TFunction } from 'i18next';
import { ApiError } from './api.js';

interface WithMsg {
  message?: string;
  label?: string;
  msg?: { id: string; params?: Record<string, string | number> };
}

function localiseWith(t: TFunction, group: string, m: WithMsg): string {
  const fallback = m.message ?? m.label ?? '';
  if (!m.msg) return fallback;
  return t(`${group}.${m.msg.id}`, {
    ...(m.msg.params ?? {}),
    defaultValue: fallback,
    interpolation: { escapeValue: false },
  });
}

/** Text of an analyzer diagnostic in the interface language. */
export const localiseDiagnostic = (t: TFunction, d: WithMsg) => localiseWith(t, 'diag', d);

/** Text of a scenario check (publish dialog, scenarios panel). */
export const localiseCheck = (t: TFunction, c: WithMsg) => localiseWith(t, 'scenarioCheck', c);

/** Text of a breaking-change mapping problem. */
export const localiseMapping = (t: TFunction, p: WithMsg) => localiseWith(t, 'mappingMsg', p);

/** Message for an API error: its code when known, else the server's English message. */
export function localiseError(t: TFunction, e: unknown): string {
  if (e instanceof ApiError) {
    const fallback = e.body.message ?? e.message;
    return e.code ? t(`apiError.${e.code}`, { defaultValue: fallback }) : fallback;
  }
  return e instanceof Error ? e.message : t('apiError.generic');
}
