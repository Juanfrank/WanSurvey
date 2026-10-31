import { describe, expect, it } from 'vitest';
import { openJsonType, selectExpr, unwrapJson, type MsColumn } from '../src/db/copy/copy.js';

const ms = (over: Partial<MsColumn>): MsColumn => ({
  name: 'c',
  type: 'nvarchar',
  maxLength: -1,
  precision: 0,
  scale: 0,
  nullable: true,
  computed: false,
  identity: false,
  ...over,
});

/** The pieces of the PostgreSQL → SQL Server copy that need no database. */
describe('data copy: conversions', () => {
  it('selects every PostgreSQL type as text, or as an integer for booleans', () => {
    expect(selectExpr({ name: 'id', udt: 'uuid' })).toBe('"id"::text');
    expect(selectExpr({ name: 'ok', udt: 'bool' })).toBe('"ok"::int');
    expect(selectExpr({ name: 'file', udt: 'bytea' })).toBe(`encode("file", 'hex')`);
    expect(selectExpr({ name: 'tags', udt: '_text' })).toBe('to_json("tags")::text');
    expect(selectExpr({ name: 'sample', udt: 'jsonb' })).toBe('"sample"::text');
    // Instants in UTC to the millisecond, the precision of datetimeoffset(3).
    expect(selectExpr({ name: 'at', udt: 'timestamptz' })).toContain(`at time zone 'UTC'`);
    expect(selectExpr({ name: 'at', udt: 'timestamptz' })).toContain('MS');
    // A name with a quote cannot break out of the statement.
    expect(selectExpr({ name: 'a"b', udt: 'text' })).toBe('"a""b"::text');
  });

  it('reads each column as the exact type SQL Server stores', () => {
    expect(openJsonType(ms({ type: 'uniqueidentifier' })).type).toBe('uniqueidentifier');
    expect(openJsonType(ms({ type: 'nvarchar', maxLength: 900 })).type).toBe('nvarchar(450)');
    expect(openJsonType(ms({ type: 'nvarchar', maxLength: -1 })).type).toBe('nvarchar(max)');
    expect(openJsonType(ms({ type: 'varchar', maxLength: 36 })).type).toBe('varchar(36)');
    expect(openJsonType(ms({ type: 'datetimeoffset', scale: 3 })).type).toBe('datetimeoffset(3)');
    expect(openJsonType(ms({ type: 'decimal', precision: 12, scale: 2 })).type).toBe(
      'decimal(12,2)',
    );
    const bin = openJsonType(ms({ type: 'varbinary', maxLength: -1 }));
    expect(bin.type).toBe('nvarchar(max)');
    expect(bin.wrap?.('[file]')).toBe('CONVERT(varbinary(max), [file], 2)');
  });

  it('unwraps a JSON document that was written as a JSON string', () => {
    expect(unwrapJson('"{\\"city\\":\\"Lima\\"}"')).toEqual({
      text: '{"city":"Lima"}',
      changed: true,
    });
    expect(unwrapJson('"[1,2]"')).toEqual({ text: '[1,2]', changed: true });
    // A document, a plain string, a scalar and null stay as they are.
    expect(unwrapJson('{"a":1}').changed).toBe(false);
    expect(unwrapJson('"hello"').changed).toBe(false);
    expect(unwrapJson('"12"').changed).toBe(false);
    expect(unwrapJson('42').changed).toBe(false);
    expect(unwrapJson(null)).toEqual({ text: null, changed: false });
  });
});
