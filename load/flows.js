// The requests the load tests send, as plain data (no k6 imports), so that the same bodies are
// checked against the real API by apps/api/test/mssql/load-flows-http.test.ts. The questionnaire
// is the one apps/api/src/db/load-setup.ts creates: AGE, SAT (1–5) and COMMENTS.

export const PATH = ['AGE', 'SAT', 'COMMENTS'];

export const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

/** The three answers of one interview, numbered from `seq + 1`. */
export function answerOps(seq, n, source, at = new Date().toISOString()) {
  const value = { AGE: 20 + (n % 60), SAT: 1 + (n % 5), COMMENTS: 'Prueba de carga' };
  return PATH.map((variable, i) => ({
    seq: seq + i + 1,
    kind: 'answer',
    variable,
    oldValue: null,
    newValue: value[variable],
    at,
    source,
  }));
}

/** The engine's snapshot after the last answer, as a client sends it: the end reached. */
export function endState(n) {
  return {
    answers: { AGE: 20 + (n % 60), SAT: 1 + (n % 5), COMMENTS: 'Prueba de carga' },
    stash: {},
    confirmations: {},
    visited: PATH,
    prefilled: [],
    position: 'COMMENTS',
    completed: true,
    language: 'es',
  };
}

/** CAWI: the browser's sync of a whole interview. */
export const cawiSync = (deviceId, n) => {
  const ops = answerOps(0, n, 'respondent');
  return {
    deviceId,
    ops,
    state: endState(n),
    position: 'COMMENTS',
    activeMs: 20000,
    totalMs: 25000,
  };
};
export const cawiSubmit = (deviceId) => ({ deviceId, seq: 3, path: PATH });

/** CATI: the call outcome that starts the telephone interview. */
export const catiAnswered = (id, deviceId, questionnaireId) => ({
  outcome: 'answered',
  connectedMs: 1000,
  interview: { id, deviceId, questionnaireId, language: 'es' },
});

/** CATI and CAPI: a sync of the interview's changes (started online or on the device). */
export const deviceSync = (deviceId, id, n, start) => ({
  deviceId,
  interviews: [
    {
      id,
      ...(start ? { start } : {}),
      ops: answerOps(0, n, 'interviewer'),
      state: endState(n),
    },
  ],
});
export const deviceSubmit = (deviceId) => ({ deviceId, seq: 3, path: PATH });

/** CAPI: how an interview started on the tablet announces itself. */
export const capiStart = (caseId, questionnaireVersionId) => ({
  caseId,
  questionnaireVersionId,
  mode: 'CAPI',
  language: 'es',
  startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
});
