/** E-mail kinds a project can word. */
export const TEMPLATE_KINDS = ['invitation', 'reminder'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export interface Template {
  subject: string;
  body: string;
}

/** Wording used until the project writes its own (W7): Spanish first, English available. */
export const DEFAULT_TEMPLATES: Record<string, Record<TemplateKind, Template>> = {
  es: {
    invitation: {
      subject: 'Le invitamos a responder una encuesta',
      body: [
        'Estimado(a) {{case.first_name}}:',
        '',
        'Le invitamos a participar en nuestra encuesta. Responderla toma pocos minutos y sus respuestas son confidenciales.',
        '',
        'Para empezar, abra este enlace:',
        '{{link}}',
        '',
        'Puede interrumpirla y continuar más tarde con el mismo enlace.',
        '',
        'Muchas gracias.',
        '',
        'Si no desea recibir más correos sobre esta encuesta: {{unsubscribe}}',
      ].join('\n'),
    },
    reminder: {
      subject: 'Recordatorio: su opinión es importante',
      body: [
        'Estimado(a) {{case.first_name}}:',
        '',
        'Hace unos días le invitamos a responder nuestra encuesta. Si aún no ha podido hacerlo, todavía está a tiempo:',
        '{{link}}',
        '',
        'Si ya empezó, el enlace le lleva a donde se quedó.',
        '',
        'Muchas gracias.',
        '',
        'Si no desea recibir más correos sobre esta encuesta: {{unsubscribe}}',
      ].join('\n'),
    },
  },
  en: {
    invitation: {
      subject: 'You are invited to take part in a survey',
      body: [
        'Dear {{case.first_name}},',
        '',
        'We invite you to take part in our survey. It takes a few minutes and your answers are confidential.',
        '',
        'To start, open this link:',
        '{{link}}',
        '',
        'You can stop and continue later with the same link.',
        '',
        'Thank you.',
        '',
        'To stop receiving e-mails about this survey: {{unsubscribe}}',
      ].join('\n'),
    },
    reminder: {
      subject: 'Reminder: your opinion matters',
      body: [
        'Dear {{case.first_name}},',
        '',
        'A few days ago we invited you to take part in our survey. If you have not had the chance yet, there is still time:',
        '{{link}}',
        '',
        'If you already started, the link takes you back to where you left off.',
        '',
        'Thank you.',
        '',
        'To stop receiving e-mails about this survey: {{unsubscribe}}',
      ].join('\n'),
    },
  },
};

export const defaultTemplate = (kind: TemplateKind, language: string): Template =>
  (DEFAULT_TEMPLATES[language] ?? DEFAULT_TEMPLATES.es!)[kind];

/**
 * Fills `{{case.field}}`, `{{link}}` and `{{unsubscribe}}`. Unknown or empty fields become
 * empty text; nothing else is interpreted (the body is plain text).
 */
export function renderTemplate(
  t: Template,
  vars: { case: Record<string, unknown>; link: string; unsubscribe: string },
): Template {
  const fill = (s: string) =>
    s.replace(/\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g, (_m, name: string) => {
      if (name === 'link') return vars.link;
      if (name === 'unsubscribe') return vars.unsubscribe;
      if (name.startsWith('case.')) {
        const v = vars.case[name.slice(5)];
        return v === null || v === undefined ? '' : String(v);
      }
      return '';
    });
  return { subject: fill(t.subject).replace(/\s+/g, ' ').trim(), body: fill(t.body) };
}

/** Variables a template may use, for the editor's check. */
export function templateProblems(t: Template): string[] {
  const out: string[] = [];
  for (const m of `${t.subject}\n${t.body}`.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    const name = m[1]!;
    if (name !== 'link' && name !== 'unsubscribe' && !/^case\.[a-zA-Z_]\w*$/.test(name))
      out.push(name);
  }
  if (!/\{\{\s*link\s*\}\}/.test(t.body)) out.push('missing:link');
  if (!/\{\{\s*unsubscribe\s*\}\}/.test(t.body)) out.push('missing:unsubscribe');
  return out;
}
