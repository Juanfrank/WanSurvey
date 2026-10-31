import { sql } from 'kysely';

/**
 * Orders ties by the text of the id. Ids are UUIDv7, so their text order is their creation order,
 * which is the order a time-ordered key gives; SQL Server sorts a `uniqueidentifier` by its last six bytes
 * first, which says nothing about when a row was made.
 */
export const idOrder = sql`CAST(id AS char(36))`;
