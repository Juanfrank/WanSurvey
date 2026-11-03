import { randomBytes } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import {
  API_KEY_MAX_DAYS,
  API_KEY_SCOPES,
  type ApiKeyBody,
  type ApiKeyScope,
} from '@wansurvey/schema';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { safeEqual, sha256Hex } from '../common/crypto.js';
import { Engine } from '../db/engine.js';

/** `wsk_<12 hex>_<43 base64url>`: the id finds the key, the secret proves it. */
const KEY = /^wsk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
/** Requests per minute and key; counted with the other rate limits (Redis when there is one). */
export const KEY_RATE_PER_MINUTE = 600;
const TOUCH_MS = 60_000;

export interface ApiKeyAuth {
  id: string;
  tenantId: string;
  scopes: ApiKeyScope[];
  projectId: string | null;
  createdBy: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  keyId: string;
  scopes: ApiKeyScope[];
  projectId: string | null;
  allowedIps: string[];
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** Whether an address is listed, as a single address or inside a CIDR range. */
export function ipAllowed(ip: string | null | undefined, allowed: string[]): boolean {
  if (!allowed.length) return true;
  if (!ip) return false;
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const family = isIP(addr);
  if (!family) return false;
  const list = new BlockList();
  for (const entry of allowed) {
    const [net, bits] = entry.split('/');
    const f = isIP(net ?? '');
    if (!f) continue;
    if (bits === undefined) list.addAddress(net!, f === 4 ? 'ipv4' : 'ipv6');
    else list.addSubnet(net!, Number(bits), f === 4 ? 'ipv4' : 'ipv6');
  }
  return list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly engine: Engine,
    private readonly audit: AuditService,
    @Inject(ThrottlerStorage) private readonly throttle: ThrottlerStorage,
  ) {}

  /** Creates a key; the secret is returned this once and never stored. */
  async create(ctx: AuthContext, body: ApiKeyBody) {
    const days = (body.expiresAt.getTime() - Date.now()) / 86_400_000;
    if (days <= 0) throw new BadRequestException('The key must expire in the future');
    if (days > API_KEY_MAX_DAYS)
      throw new BadRequestException(`A key may last at most ${API_KEY_MAX_DAYS} days`);
    for (const e of body.allowedIps) {
      const [net, bits] = e.split('/');
      const f = isIP(net ?? '');
      if (
        !f ||
        (bits !== undefined && !(Number(bits) >= 0 && Number(bits) <= (f === 4 ? 32 : 128)))
      )
        throw new BadRequestException(`Not an address or range: ${e}`);
    }
    const keyId = randomBytes(6).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const id = uuidv7();
    await this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      if (body.projectId) {
        const p = await tx
          .selectFrom('projects')
          .select('id')
          .where('id', '=', body.projectId)
          .executeTakeFirst();
        if (!p) throw new NotFoundException('Project not found');
      }
      await tx
        .insertInto('api_keys')
        .values({
          id,
          tenant_id: ctx.tenantId,
          key_id: keyId,
          secret_hash: sha256Hex(secret),
          name: body.name,
          scopes: JSON.stringify(body.scopes),
          project_id: body.projectId,
          allowed_ips: body.allowedIps.length ? JSON.stringify(body.allowedIps) : null,
          expires_at: body.expiresAt,
          created_by: ctx.userId,
        })
        .execute();
      await this.audit.recordIn(tx, ctx, {
        action: 'apikey.created',
        targetType: 'api_key',
        targetId: id,
        details: {
          name: body.name,
          scopes: body.scopes,
          projectId: body.projectId,
          expiresAt: body.expiresAt.toISOString(),
          allowedIps: body.allowedIps,
        },
      });
    });
    return { id, key: `wsk_${keyId}_${secret}` };
  }

  async list(ctx: AuthContext): Promise<ApiKeyRow[]> {
    const rows = await this.engine.sql.withTenant(ctx.tenantId, (tx) =>
      tx.selectFrom('api_keys').selectAll().orderBy('created_at', 'desc').execute(),
    );
    return rows.map((r) => ({
      id: r.id.toLowerCase(),
      name: r.name,
      keyId: r.key_id,
      scopes: JSON.parse(r.scopes) as ApiKeyScope[],
      projectId: r.project_id ? r.project_id.toLowerCase() : null,
      allowedIps: r.allowed_ips ? (JSON.parse(r.allowed_ips) as string[]) : [],
      expiresAt: new Date(r.expires_at as never),
      createdAt: new Date(r.created_at as never),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at as never) : null,
      revokedAt: r.revoked_at ? new Date(r.revoked_at as never) : null,
    }));
  }

  async revoke(ctx: AuthContext, id: string) {
    await this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      const done = await tx
        .updateTable('api_keys')
        .set({ revoked_at: new Date(), revoked_by: ctx.userId })
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!Number(done.numUpdatedRows)) throw new NotFoundException('Key not found');
      await this.audit.recordIn(tx, ctx, {
        action: 'apikey.revoked',
        targetType: 'api_key',
        targetId: id,
      });
    });
  }

  /**
   * Who a bearer key is, or why not. Every refusal answers the same 401 so a probe cannot tell
   * an unknown id from a wrong secret, an expired key or a forbidden address.
   */
  async authenticate(header: string | undefined, ip: string | null): Promise<ApiKeyAuth> {
    const refuse = () =>
      new UnauthorizedException({ code: 'INVALID_API_KEY', message: 'Invalid API key' });
    const m = KEY.exec(header?.startsWith('Bearer ') ? header.slice(7).trim() : '');
    if (!m) throw refuse();
    const row = await this.engine.sql.apiKeyLookup(m[1]!);
    // Compared even when the key is unknown, so the time does not tell.
    const ok = safeEqual(sha256Hex(m[2]!), row?.secret_hash ?? '0'.repeat(64));
    if (!row || !ok) throw refuse();
    if (row.revoked_at || new Date(row.expires_at) <= new Date()) throw refuse();
    const allowed = row.allowed_ips ? (JSON.parse(row.allowed_ips) as string[]) : [];
    if (!ipAllowed(ip, allowed)) throw refuse();

    const hits = await this.throttle.increment(
      `key:${row.id}`,
      60_000,
      KEY_RATE_PER_MINUTE,
      0,
      'ext',
    );
    if (hits.totalHits > KEY_RATE_PER_MINUTE)
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many requests for this key' },
        HttpStatus.TOO_MANY_REQUESTS,
      );

    const tenantId = row.tenant_id.toLowerCase();
    const id = row.id.toLowerCase();
    // last_used_at moves at most once a minute; a failure to record it never stops the request.
    void this.engine.sql
      .withTenant(tenantId, (tx) =>
        sql`UPDATE dbo.api_keys SET last_used_at = SYSDATETIMEOFFSET()
            WHERE id = ${id} AND (last_used_at IS NULL
              OR last_used_at < DATEADD(millisecond, ${-TOUCH_MS}, SYSDATETIMEOFFSET()))`.execute(
          tx,
        ),
      )
      .catch(() => undefined);
    const scopes = (JSON.parse(row.scopes) as string[]).filter((s): s is ApiKeyScope =>
      (API_KEY_SCOPES as readonly string[]).includes(s),
    );
    return {
      id,
      tenantId,
      scopes,
      projectId: row.project_id ? row.project_id.toLowerCase() : null,
      createdBy: row.created_by.toLowerCase(),
    };
  }
}
