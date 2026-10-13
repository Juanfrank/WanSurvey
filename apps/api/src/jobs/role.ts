/** Which process this is: the HTTP API or the background worker. */
export type ProcessRole = 'api' | 'worker';
export const PROCESS_ROLE = Symbol('PROCESS_ROLE');
