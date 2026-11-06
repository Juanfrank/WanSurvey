import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { CONTACT_CHANNELS } from '@wansurvey/schema';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { parseDate } from '../cases/sample-mapping.js';
import { Engine } from '../db/engine.js';
import { REASONS, RegistryService, parseContact } from './registry.service.js';
import type { NoContactInput, ParticipationInput } from './registry-store.mssql.js';

const DAY = 86_400_000;
const Channels = z.array(z.enum(CONTACT_CHANNELS)).min(1).max(4).nullable().default(null);
const CountryCode = z
  .string()
  .regex(/^\d{1,4}$/)
  .optional();

const EntryBody = z.strictObject({
  value: z.string().trim().min(3).max(450),
  reason: z.enum(REASONS).default('do_not_contact'),
  channels: Channels,
  /** Days it lasts from now; null: permanent. */
  days: z.number().int().min(1).max(36_500).nullable().default(null),
  note: z.string().max(1000).optional(),
  defaultCountryCode: CountryCode,
});

const ImportRow = z.strictObject({
  value: z.string().max(450),
  reason: z.string().max(40).optional(),
  /** Modes separated by commas or semicolons; empty: every channel. */
  channels: z.string().max(100).optional(),
  /** A date (YYYY-MM-DD or DD/MM/YYYY) until which it holds; empty: permanent. */
  until: z.string().max(20).optional(),
  note: z.string().max(1000).optional(),
});
const NoContactImport = z.strictObject({
  defaultCountryCode: CountryCode,
  rows: z.array(ImportRow).min(1).max(2000),
});

const HistoryRow = z.strictObject({
  value: z.string().max(450),
  channel: z.string().max(20),
  date: z.string().max(30),
  result: z.string().max(64).optional(),
  project: z.string().max(450).optional(),
});
const HistoryImport = z.strictObject({
  defaultCountryCode: CountryCode,
  rows: z.array(HistoryRow).min(1).max(2000),
});

const Query_ = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(['active', 'lifted', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The reasons as the area writes them in its files, besides the codes. */
const REASON_ALIASES: Record<string, (typeof REASONS)[number]> = {
  no_llamar: 'do_not_contact',
  'no llamar': 'do_not_contact',
  no_contactar: 'do_not_contact',
  'no contactar': 'do_not_contact',
  no_interesado: 'not_interested',
  'no interesado': 'not_interested',
  queja: 'complaint',
  fallecido: 'deceased',
  otro: 'other',
};

const reasonOf = (raw?: string): (typeof REASONS)[number] | null => {
  const r = (raw ?? '').trim().toLowerCase();
  if (!r) return 'do_not_contact';
  if ((REASONS as readonly string[]).includes(r)) return r as (typeof REASONS)[number];
  return REASON_ALIASES[r] ?? null;
};

const channelsOf = (raw?: string): string[] | null | 'bad' => {
  const parts = (raw ?? '')
    .split(/[,;]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (!parts.length) return null;
  return parts.every((p) => (CONTACT_CHANNELS as readonly string[]).includes(p))
    ? [...new Set(parts)]
    : 'bad';
};

/** The people registry: the no-contact list and who took part in what (ADR 0002). */
@ApiTags('registry')
@Controller('registry')
export class RegistryController {
  constructor(
    private readonly engine: Engine,
    private readonly registry: RegistryService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(
    ctx: AuthContext,
    fn: (tx: Parameters<Parameters<Engine['sql']['withTenant']>[1]>[0]) => Promise<T>,
  ) {
    return this.engine.sql.withTenant(ctx.tenantId, fn);
  }

  @Get('no-contact')
  @RequirePermission('registry.read')
  list(@Auth() ctx: AuthContext, @Query(new ZodPipe(Query_)) q: z.infer<typeof Query_>) {
    return this.run(ctx, (tx) => this.registry.store.list(tx, ctx.tenantId, q));
  }

  @Post('no-contact')
  @HttpCode(200)
  @RequirePermission('registry.manage')
  @ApiBody({ schema: z.toJSONSchema(EntryBody) as object })
  async add(@Auth() ctx: AuthContext, @Body(new ZodPipe(EntryBody)) b: z.infer<typeof EntryBody>) {
    const c = parseContact(b.value, b.defaultCountryCode);
    if (!c)
      throw new BadRequestException({
        code: 'BAD_CONTACT',
        message: 'That is not a phone number (with its country code) or an e-mail',
      });
    return this.run(ctx, (tx) =>
      this.registry.add(
        tx,
        ctx,
        [
          {
            ...c,
            channels: b.channels,
            reason: b.reason,
            source: 'manual',
            note: b.note ?? null,
            expiresAt: b.days ? new Date(Date.now() + b.days * DAY) : null,
          },
        ],
        'manual',
      ),
    );
  }

  @Delete('no-contact/:id')
  @RequirePermission('registry.manage')
  async lift(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.run(ctx, async (tx) => {
      if (!(await this.registry.store.lift(tx, ctx.tenantId, id, ctx.userId)))
        throw new NotFoundException('Entry not found');
      await this.audit.recordIn(tx, ctx, {
        action: 'registry.no_contact_lifted',
        targetType: 'no_contact',
        targetId: id,
      });
    });
    return { lifted: true };
  }

  /** Loads a list of people not to contact; rows that cannot be read are reported, not loaded. */
  @Post('no-contact/import')
  @HttpCode(200)
  @RequirePermission('registry.manage')
  @ApiBody({ schema: z.toJSONSchema(NoContactImport) as object })
  async importNoContact(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(NoContactImport)) b: z.infer<typeof NoContactImport>,
  ) {
    const entries: NoContactInput[] = [];
    const rejected: { row: number; why: string }[] = [];
    b.rows.forEach((r, i) => {
      const c = parseContact(r.value, b.defaultCountryCode);
      const reason = reasonOf(r.reason);
      const channels = channelsOf(r.channels);
      const until = r.until?.trim() ? parseDate(r.until) : null;
      const why = !c
        ? 'contact'
        : !reason
          ? 'reason'
          : channels === 'bad'
            ? 'channels'
            : r.until?.trim() && !until
              ? 'until'
              : null;
      if (why) return void rejected.push({ row: i + 1, why });
      entries.push({
        ...c!,
        channels: channels as string[] | null,
        reason: reason!,
        source: 'import',
        note: r.note ?? null,
        expiresAt: until ? new Date(`${until}T23:59:59Z`) : null,
      });
    });
    // The same value twice in a file: the last row wins.
    const last = new Map(entries.map((e) => [`${e.kind}\u0000${e.value}`, e]));
    const res = await this.run(ctx, (tx) =>
      this.registry.add(tx, ctx, [...last.values()], 'import'),
    );
    return { ...res, rejected: rejected.length, examples: rejected.slice(0, 20) };
  }

  /** Loads who took part in what (the history); rows that cannot be read are reported. */
  @Post('participations/import')
  @HttpCode(200)
  @RequirePermission('registry.manage')
  @ApiBody({ schema: z.toJSONSchema(HistoryImport) as object })
  async importHistory(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(HistoryImport)) b: z.infer<typeof HistoryImport>,
  ) {
    const rows: ParticipationInput[] = [];
    const rejected: { row: number; why: string }[] = [];
    b.rows.forEach((r, i) => {
      const c = parseContact(r.value, b.defaultCountryCode);
      const channel = r.channel.trim().toUpperCase();
      const date = parseDate(r.date);
      const why = !c
        ? 'contact'
        : !(CONTACT_CHANNELS as readonly string[]).includes(channel)
          ? 'channel'
          : !date
            ? 'date'
            : null;
      if (why) return void rejected.push({ row: i + 1, why });
      rows.push({
        ...c!,
        channel,
        occurredAt: new Date(`${date}T12:00:00Z`),
        result: r.result?.trim() || null,
        projectName: r.project?.trim() || null,
        source: 'history',
      });
    });
    await this.run(ctx, async (tx) => {
      await this.registry.store.addParticipations(tx, ctx.tenantId, rows);
      await this.audit.recordIn(tx, ctx, {
        action: 'registry.history_loaded',
        targetType: 'participations',
        details: { loaded: rows.length, rejected: rejected.length },
      });
    });
    return { loaded: rows.length, rejected: rejected.length, examples: rejected.slice(0, 20) };
  }

  /** What the registry knows of one phone or e-mail. */
  @Get('lookup')
  @RequirePermission('registry.read')
  async lookup(
    @Auth() ctx: AuthContext,
    @Query(new ZodPipe(z.object({ value: z.string().min(3).max(450), cc: CountryCode })))
    q: { value: string; cc?: string | undefined },
  ) {
    const c = parseContact(q.value, q.cc);
    if (!c)
      throw new BadRequestException({ code: 'BAD_CONTACT', message: 'Not a phone or an e-mail' });
    return this.run(ctx, async (tx) => ({
      ...c,
      noContact: await this.registry.store.entriesOf(tx, ctx.tenantId, c.value),
      participations: await this.registry.store.participationsOf(tx, ctx.tenantId, c.value),
    }));
  }
}
