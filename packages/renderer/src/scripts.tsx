import type { InterviewSession } from '@wansurvey/logic';
import { useTranslation } from 'react-i18next';
import { RENDERER_NS } from './i18n.js';

/** Script bodies are a small HTML subset; the interviewer reads them as plain text. */
export const scriptText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

/**
 * Scripts to read on arriving at `key`: the opening script on the first question, a section's
 * script on its first question, and the item's own script.
 */
export function scriptsAt(session: InterviewSession, key: string) {
  const out: { id: string; text: string }[] = [];
  const trace = session.trace();
  let section: string | null = null;
  let firstOfSection = false;
  let firstOnPath = true;
  let seenInSection = false;
  for (const e of trace) {
    if (e.kind === 'section' && e.depth === 0) {
      section = e.id;
      seenInSection = false;
      continue;
    }
    if (e.status !== 'active' || (e.kind !== 'question' && e.kind !== 'static')) continue;
    if (e.key === key) {
      firstOfSection = !seenInSection;
      break;
    }
    seenInSection = true;
    firstOnPath = false;
  }
  if (firstOnPath) out.push(...session.scriptsFor({ at: 'start' }));
  if (section && firstOfSection)
    out.push(...session.scriptsFor({ at: 'section', sectionId: section }));
  out.push(...session.scriptsFor({ at: 'item', key }));
  return out;
}

/** A script for the interviewer to read aloud. */
export function ScriptBox({ scripts }: { scripts: { id: string; text: string }[] }) {
  const { t } = useTranslation(RENDERER_NS);
  if (!scripts.length) return null;
  return (
    <aside
      aria-label={t('script.label')}
      data-testid="script"
      className="rounded-md border-l-4 border-indigo-400 bg-indigo-50 px-3 py-2 text-sm text-indigo-ink-950"
    >
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-indigo-ink-800">
        {t('script.label')}
      </p>
      {scripts.map((s) => (
        <p key={s.id} className="whitespace-pre-line" data-script={s.id}>
          {scriptText(s.text)}
        </p>
      ))}
    </aside>
  );
}
