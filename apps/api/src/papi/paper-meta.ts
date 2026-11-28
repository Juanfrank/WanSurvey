/** The longest interview a paper form may report, in minutes (as the entry screen). */
export const MAX_FORM_MINUTES = 600;

/** The latest local date anywhere on Earth now (UTC+14): a form cannot be dated after it. */
export const latestToday = (now = new Date()) =>
  new Date(now.getTime() + 14 * 3_600_000).toISOString().slice(0, 10);

/** Whether `s` is a real calendar day written as YYYY-MM-DD (2026-02-30 is not). */
function realDay(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m! - 1 && day.getUTCDate() === d;
}

/**
 * The date and duration written on a paper form (`paper_meta` paradata, P4), checked on the
 * server as on the entry screen (126): a real day not after today, and a whole number of
 * minutes from 1 to 600; both may be left out. A wrong value is kept as null (never stored as
 * sent) and reported, so the device shows why.
 */
export function checkPaperMeta(
  payload: Record<string, unknown>,
  now = new Date(),
): { payload: Record<string, unknown>; invalid: boolean } {
  const out = { ...payload };
  let invalid = false;
  const date = payload.date;
  if (date !== undefined && date !== null) {
    if (typeof date !== 'string' || !realDay(date) || date > latestToday(now)) {
      out.date = null;
      invalid = true;
    }
  }
  const minutes = payload.minutes;
  if (minutes !== undefined && minutes !== null) {
    if (
      typeof minutes !== 'number' ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > MAX_FORM_MINUTES
    ) {
      out.minutes = null;
      invalid = true;
    }
  }
  return { payload: out, invalid };
}
