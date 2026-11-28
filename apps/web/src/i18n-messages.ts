import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from './api.js';
import { dateTime } from './format.js';

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
  const code = (e as { code?: unknown } | null)?.code;
  if (e instanceof Error && typeof code === 'string')
    return t(`apiError.${code}`, { defaultValue: e.message });
  return e instanceof Error ? e.message : t('apiError.generic');
}

/** A case or interview disposition (COMPLETE, REFUSAL…) in the interface language. */
export const dispositionLabel = (t: TFunction, code: string) =>
  t(`analysis.dispositionLabels.${code}`, { defaultValue: code });

/** A data-collection mode (CATI, CAPI, CAWI, PAPI) by its everyday name. */
export const modeLabel = (t: TFunction, mode: string) =>
  t(`analysis.modes.${mode}`, { defaultValue: mode });

/**
 * A status message ("Settings saved.", "11 personal links made.") kept as its translation key
 * and values, or as the error it reports, and written out in the interface language each time
 * it is shown. A message kept as finished text stayed in the language of the moment it was
 * made: switch the language and it did not follow.
 *
 * - `{ key, vars }`: a value of `vars` that is itself a note is written out too (a status name
 *   inside the sentence, `{ key: 'interview.status.approved' }`).
 * - `{ error }`: written out with `localiseError`.
 * - `{ parts }`: sentences one after the other ("12 cases assigned. 3 were skipped.").
 * - `{ dateTime }`: a moment, in the short date and time of the current language.
 * - `{ text }`: what has no language (an address to copy by hand).
 */
export type Note =
  | { key: string; vars?: Record<string, unknown> }
  | { error: unknown }
  | { text: string }
  | { dateTime: string | number | Date }
  | { parts: Note[] }
  | null;

const NOTE_KINDS = ['key', 'error', 'text', 'dateTime', 'parts'];
const isNote = (v: unknown): v is Exclude<Note, null> =>
  !!v && typeof v === 'object' && !(v instanceof Date) && NOTE_KINDS.some((k) => k in v);

/** Writes a `Note` out in the current language ('' for none). */
export function noteText(t: TFunction, note: Note): string {
  if (!note) return '';
  if ('error' in note) return localiseError(t, note.error);
  if ('text' in note) return note.text;
  if ('dateTime' in note) return dateTime(note.dateTime);
  if ('parts' in note)
    return note.parts
      .map((p) => noteText(t, p))
      .filter(Boolean)
      .join(' ');
  const vars = Object.fromEntries(
    Object.entries(note.vars ?? {}).map(([k, v]) => [k, isNote(v) ? noteText(t, v) : v]),
  );
  return t(note.key, vars);
}

/**
 * `useState` for a status message: `[text, setNote]`, where `text` is drafted at each render
 * (so it follows the language) and `setNote({ key, vars })`, `setNote({ error })` or
 * `setNote(null)` changes it.
 *
 *   const [message, setMessage] = useNote();
 *   onSuccess: (r) => setMessage({ key: 'cawi.links.made', vars: { count: r.links } }),
 *   onError: (e) => setMessage({ error: e }),
 *   <p role="status">{message}</p>
 */
export function useNote(initial: Note = null) {
  const { t } = useTranslation();
  const [note, setNote] = useState<Note>(initial);
  return [noteText(t, note), setNote] as const;
}
