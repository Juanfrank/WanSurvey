import { WithSchemaPlugin, type Kysely, type KyselyPlugin, type RootOperationNode } from 'kysely';
import { createMssqlDb, type MssqlOptions } from './connection.js';
import { DEFAULT_SCHEMA, migrationFiles, qualifyTables, sqlName, tablesOf } from './migrate.js';

/** Names the schema in the plain SQL of an owner's statements (see `qualifyTables`). */
class QualifyRawSql implements KyselyPlugin {
  constructor(
    private readonly schema: string,
    private readonly tables: Set<string>,
  ) {}
  transformQuery(args: { node: RootOperationNode }): RootOperationNode {
    const node = args.node as RootOperationNode & { kind: string; sqlFragments?: string[] };
    if (node.kind !== 'RawNode' || !node.sqlFragments) return args.node;
    return {
      ...node,
      sqlFragments: node.sqlFragments.map((f) => qualifyTables(f, this.tables, this.schema)),
    } as unknown as RootOperationNode;
  }
  async transformResult<T>(args: { result: T }): Promise<T> {
    return args.result;
  }
}

let tables: Set<string> | undefined;

/**
 * A connection as the database owner for scripts and tests: seeding, set-ups, fixtures. The owner
 * has `dbo` as its default schema whatever the application's is, so, when the application lives in
 * another schema (`DATABASE_SCHEMA`), the tables of its statements are named with it: in query
 * builders and in plain SQL alike. In `dbo` it is an ordinary connection. The application's own
 * connections never use this: their user has the schema as its default.
 */
export function createOwnerDb<DB>(
  url: string,
  opts: MssqlOptions & { schema?: string } = {},
): Kysely<DB> {
  const schema = sqlName(
    'The schema',
    opts.schema ?? process.env.DATABASE_SCHEMA ?? DEFAULT_SCHEMA,
  );
  const db = createMssqlDb<DB>(url, opts);
  if (schema === DEFAULT_SCHEMA) return db;
  tables ??= tablesOf(migrationFiles());
  return db.withPlugin(new WithSchemaPlugin(schema)).withPlugin(new QualifyRawSql(schema, tables));
}
