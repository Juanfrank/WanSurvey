import { sql } from 'kysely';

/**
 * An instant to the millisecond for a `datetimeoffset(3)` column. A `Date` parameter travels as
 * `datetime`, which rounds to 3.33 ms, so what is written (or compared) can land a millisecond off
 * the value the application means. Sent as text and converted, it is exact.
 */
export const instant = (d: Date) => sql<Date>`CAST(${d.toISOString()} AS datetimeoffset(3))`;
