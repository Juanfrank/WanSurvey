/**
 * Respondent pages speak the questionnaire's language, not the staff interface's (L44): a
 * small catalogue of their own, Spanish first.
 */
export const TEXT = {
  es: {
    loading: 'Cargando la encuesta…',
    notFound: 'Este enlace no es válido o ya no está disponible.',
    closed: 'Esta encuesta está cerrada.',
    unavailable: 'Esta encuesta no está disponible por ahora.',
    ended: 'Esta encuesta finalizó. ¡Gracias por su interés!',
    failed: 'No se pudo abrir la encuesta. Inténtelo de nuevo en unos minutos.',
    saving: 'Guardando…',
    saved: 'Respuestas guardadas',
    offline: 'Sin conexión: sus respuestas se guardan en este dispositivo.',
    notKept:
      'Este dispositivo no puede guardar sus respuestas: no cierre esta página hasta enviarlas.',
    send: 'Enviar mis respuestas',
    sending: 'Enviando…',
    sendFailed: 'No se pudieron enviar sus respuestas. Inténtelo de nuevo.',
    thanks: '¡Muchas gracias por responder la encuesta!',
    already: 'Usted ya respondió esta encuesta. ¡Gracias!',
    continue: 'Continuar',
    unsubscribeTitle: 'Dejar de recibir correos',
    unsubscribeText: 'No volveremos a escribir a {email} sobre esta encuesta.',
    unsubscribeButton: 'Confirmar',
    unsubscribed: 'Listo: no recibirá más correos sobre esta encuesta.',
    start: 'Empezar la encuesta',
  },
  en: {
    loading: 'Loading the survey…',
    notFound: 'This link is not valid or no longer available.',
    closed: 'This survey is closed.',
    unavailable: 'This survey is not available at the moment.',
    ended: 'This survey has ended. Thank you for your interest!',
    failed: 'The survey could not be opened. Please try again in a few minutes.',
    saving: 'Saving…',
    saved: 'Answers saved',
    offline: 'No connection: your answers are kept on this device.',
    notKept: 'This device cannot keep your answers: do not close this page until you send them.',
    send: 'Send my answers',
    sending: 'Sending…',
    sendFailed: 'Your answers could not be sent. Please try again.',
    thanks: 'Thank you very much for taking part!',
    already: 'You have already answered this survey. Thank you!',
    continue: 'Continue',
    unsubscribeTitle: 'Stop receiving e-mails',
    unsubscribeText: 'We will not write to {email} about this survey again.',
    unsubscribeButton: 'Confirm',
    unsubscribed: 'Done: you will not receive more e-mails about this survey.',
    start: 'Start the survey',
  },
};

export type RespondentText = (typeof TEXT)['es'];

/** The respondent page language this catalogue has for `lang` (Spanish when it has none). */
export const respondentLang = (lang: string): keyof typeof TEXT => {
  const base = lang.split('-')[0] ?? 'es';
  return base in TEXT ? (base as keyof typeof TEXT) : 'es';
};

export const respondentText = (lang: string): RespondentText => TEXT[respondentLang(lang)];
