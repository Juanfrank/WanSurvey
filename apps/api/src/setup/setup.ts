import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.js';
import { buildScript } from '../db/mssql/script.js';
import { VERSION } from '../version.js';

/** The installation has no database settings yet: the API runs only this wizard. */
export const setupRequired = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !env.DATABASE_URL?.trim();

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** What the wizard asks: names and addresses only, never a password. */
export const SetupRequest = z.object({
  server: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,253}$/, 'The address of the SQL Server, for example sql.example.org'),
  port: z.number().int().min(1).max(65535).default(1433),
  database: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]{1,128}$/, 'The name of the database'),
  schema: z.string().trim().regex(NAME, 'Letters, digits and underscores').default('dbo'),
  ownerUser: z.string().trim().regex(NAME, 'Letters, digits and underscores').default('owner'),
  appUser: z.string().trim().regex(NAME, 'Letters, digits and underscores'),
  readonlyUser: z
    .string()
    .trim()
    .regex(NAME, 'Letters, digits and underscores')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** The DBA makes the users: the second script then only checks them and grants. */
  usersByDba: z.boolean().default(false),
});
export type SetupRequest = z.infer<typeof SetupRequest>;

/** The two scripts and the settings to put in the environment, from the names given. */
export function setupPlan(r: SetupRequest) {
  if (r.readonlyUser && r.readonlyUser.toLowerCase() === r.appUser.toLowerCase())
    throw new Error('The read-only user must not be the read/write user');
  const base = { schema: r.schema, appUser: r.appUser, usersByDba: r.usersByDba };
  const names = {
    ...base,
    ...(r.readonlyUser ? { readonlyUser: r.readonlyUser } : {}),
  };
  const url = (user: string) =>
    `mssql://${user}:<password>@${r.server}:${r.port}/${r.database}?encrypt=true`;
  const settings = [
    { name: 'DATABASE_URL', value: url(r.appUser), secret: true },
    ...(r.readonlyUser
      ? [{ name: 'DATABASE_READONLY_URL', value: url(r.readonlyUser), secret: true }]
      : []),
    { name: 'DATABASE_ADMIN_URL', value: url(r.ownerUser), secret: true, onlyToMigrate: true },
    { name: 'DATABASE_SCHEMA', value: r.schema, secret: false },
    ...(r.usersByDba ? [{ name: 'DATABASE_MANAGE_USERS', value: 'false', secret: false }] : []),
  ];
  return {
    tables: buildScript({ ...names, part: 'tables' }),
    users: buildScript({ ...names, part: 'users' }),
    settings,
    passwordVariables: r.usersByDba
      ? []
      : ['AppPassword', ...(r.readonlyUser ? ['ReaderPassword'] : [])],
  };
}

@Controller('setup')
export class SetupController {
  @Get('status')
  status() {
    return { setup: true, version: VERSION };
  }

  /** Stateless: it writes nothing and connects to nothing; the scripts hold no secret. */
  @Post('scripts')
  scripts(@Body(new ZodPipe(SetupRequest)) body: SetupRequest) {
    return setupPlan(body);
  }
}

@Controller('health')
export class SetupHealthController {
  @Get()
  health() {
    return { status: 'setup' };
  }
}

@Module({ controllers: [SetupController, SetupHealthController] })
export class SetupModule {}
