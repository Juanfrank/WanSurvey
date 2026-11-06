import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CONTACT_CHANNELS, type ContactRules } from '@wansurvey/schema';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { InterviewsService } from '../interviews/interviews.service.js';
import { normaliseEmail, normalisePhone } from '../cases/sample-mapping.js';
import {
  RegistryStore,
  type ContactKind,
  type NoContactInput,
  type NoContactRow,
} from './registry-store.mssql.js';

export const REASONS = [
  'do_not_contact',
  'not_interested',
  'complaint',
  'deceased',
  'other',
] as const;
export type Reason = (typeof REASONS)[number];

const DAY = 86_400_000;
export const key = (kind: ContactKind, value: string) => `${kind}\u0000${value}`;

/** A phone (E.164 when it has a country code) or an e-mail, as the registry keeps it. */
export function parseContact(
  raw: string,
  countryCode?: string,
): { kind: ContactKind; value: string } | null {
  const v = raw.trim();
  if (v.includes('@')) {
    const e = normaliseEmail(v);
    return e ? { kind: 'email', value: e } : null;
  }
  const p = normalisePhone(v, countryCode);
  return p ? { kind: 'phone', value: p } : null;
}

/**
 * The people registry (ADR 0002): the no-contact list and who took part in what, by contact
 * value. Other modules ask it who must not be contacted; it records participations as
 * interviews are submitted.
 */
@Injectable()
export class RegistryService implements OnModuleInit {
  readonly store = new RegistryStore();

  constructor(
    private readonly runtime: InterviewsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    // Submitting an interview of a case records that the person took part, by channel.
    this.runtime.onSubmitted(async (t, row, disposition) => {
      if (!row.caseId) return;
      const { tx, tenantId } = t.handle();
      const contacts = await this.store.contactsOfCase(tx, row.caseId);
      await this.store.addParticipations(
        tx,
        tenantId,
        contacts.map((c) => ({
          kind: c.kind,
          value: c.value,
          channel: row.mode,
          occurredAt: row.endedAt ?? new Date(),
          result: disposition,
          projectName: c.projectName,
          source: 'system' as const,
          caseId: row.caseId,
        })),
      );
    });
  }

  /** The entries in force for these values, for the channels given (all when none is). */
  async blocked(
    tx: MssqlTx,
    tenantId: string,
    items: { kind: ContactKind; value: string }[],
    channels?: readonly string[],
  ): Promise<Map<string, NoContactRow>> {
    if (!channels) return this.store.blocked(tx, tenantId, items);
    const out = new Map<string, NoContactRow>();
    for (const ch of channels)
      for (const [k, v] of await this.store.blocked(tx, tenantId, items, ch)) out.set(k, v);
    return out;
  }

  /** Values with a participation inside the project's exclusion window; none when it is off. */
  async recentlySurveyed(
    tx: MssqlTx,
    tenantId: string,
    rules: ContactRules,
    items: { kind: ContactKind; value: string }[],
    now = new Date(),
  ): Promise<Set<string>> {
    const days = rules.exclusion.days;
    if (!days) return new Set();
    return this.store.recent(
      tx,
      tenantId,
      items,
      new Date(now.getTime() - days * DAY),
      rules.exclusion.channels,
    );
  }

  /** Adds entries and records it in the activity log (one line per call, with the count). */
  async add(
    tx: MssqlTx,
    ctx: AuthContext,
    entries: NoContactInput[],
    source: 'call' | 'manual' | 'import',
  ) {
    const res = await this.store.upsert(tx, ctx.tenantId, ctx.userId, entries);
    if (entries.length)
      await this.audit.recordIn(tx, ctx, {
        action: 'registry.no_contact_added',
        targetType: 'no_contact',
        details: { source, count: entries.length, ...res },
      });
    return res;
  }

  /**
   * "Do not contact" in a call: every phone and e-mail of the case, for every channel, for the
   * time the project sets.
   */
  async fromCall(
    tx: MssqlTx,
    ctx: AuthContext,
    caseId: string,
    rules: ContactRules,
    note?: string,
    now = new Date(),
  ) {
    const days = rules.noContact.defaultDays;
    const contacts = await this.store.contactsOfCase(tx, caseId);
    const unique = new Map(contacts.map((c) => [key(c.kind, c.value), c]));
    return this.add(
      tx,
      ctx,
      [...unique.values()].map((c) => ({
        kind: c.kind,
        value: c.value,
        channels: null,
        reason: 'do_not_contact',
        source: 'call',
        note: note ?? null,
        expiresAt: days ? new Date(now.getTime() + days * DAY) : null,
      })),
      'call',
    );
  }
}

export { CONTACT_CHANNELS };
