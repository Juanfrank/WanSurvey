import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { decryptField } from '../common/crypto.js';
import { SecretResolver } from '../common/key-vault.js';
import { CONFIG, type AppConfig } from '../config.js';
import type { SsoPublicConfig } from '../db/common.js';
import { Engine } from '../db/engine.js';
import { IdentityStore } from './identity-store.mssql.js';
import { BUS, type Bus } from '../jobs/bus.js';

/** An organisation's Microsoft sign-in, ready to use (the secret decrypted). */
export interface SsoConfig {
  tenantId: string;
  entraTenantId: string;
  clientId: string;
  clientSecret: string | null;
  enabled: boolean;
  enforceSso: boolean;
  /** Create the account (no role) of whoever first signs in; false: only people already added. */
  autoProvision: boolean;
  allowedDomains: string[];
  /** From the deployment's settings (ENTRA_*), not from the organisation's own. */
  fromDeployment: boolean;
}

/** What starting a sign-in needs: no secret. */
export type SsoStartConfig = Pick<
  SsoPublicConfig,
  'tenantId' | 'entraTenantId' | 'clientId' | 'enabled'
>;

/** How long a configuration read from the database is reused by this process. */
const TTL_MS = 60_000;
/** Every process hears of a change to an organisation's settings here. */
const CHANNEL = 'sso-config';

interface Cached<T> {
  value: T;
  at: number;
}

/**
 * Where each organisation's Microsoft sign-in comes from, read once a minute per process
 * instead of on every sign-in (at the start of a field day hundreds come within minutes).
 * A change saved in the app reaches every process at once through the bus; the minute is the
 * fallback if the bus is down. When the deployment sets a directory (ENTRA_*), every organisation
 * with Microsoft sign-in turned on uses it in place of one of its own (its row keeps what is
 * its own: on or off, the domains, whether Microsoft is required); the organisation is found from
 * the e-mail's domain.
 */
@Injectable()
export class SsoConfigs implements OnModuleDestroy {
  private readonly byTenant = new Map<string, Cached<SsoConfig | null>>();
  /** Only organisations that exist: an unknown slug is never kept (anyone can send one). */
  private readonly idBySlug = new Map<string, Cached<string>>();
  private readonly startSlugs = new Map<string, Cached<SsoStartConfig>>();
  /** Counts changes: a read that began before one is not kept, it may hold the old row. */
  private generation = 0;
  private readonly unsubscribe: () => void;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BUS) private readonly bus: Bus,
    private readonly engine: Engine,
    @Optional() private readonly secrets: SecretResolver = new SecretResolver(),
  ) {
    this.unsubscribe = bus.subscribe(CHANNEL, (m) => {
      if (typeof m.tenantId === 'string') this.forget(m.tenantId);
    });
  }

  onModuleDestroy() {
    this.unsubscribe();
  }

  /** The deployment's directory, when complete (the configuration checks it is whole). */
  private get deployment() {
    const c = this.config;
    return c.ENTRA_TENANT_ID && c.ENTRA_CLIENT_ID && c.ENTRA_CLIENT_SECRET
      ? {
          entraTenantId: c.ENTRA_TENANT_ID.toLowerCase(),
          clientId: c.ENTRA_CLIENT_ID.toLowerCase(),
          secret: c.ENTRA_CLIENT_SECRET,
          allowedDomains: c.ENTRA_ALLOWED_DOMAINS,
        }
      : null;
  }

  /** The domains an organisation lets in through the directory, within what the deployment allows. */
  private domainsOf(own: string[]): string[] {
    const d = this.deployment;
    return d && d.allowedDomains.length ? own.filter((x) => d.allowedDomains.includes(x)) : own;
  }

  private get db() {
    return this.engine.sql;
  }

  private readonly identity = new IdentityStore();

  private fresh<T>(hit: Cached<T> | undefined): hit is Cached<T> {
    return !!hit && Date.now() - hit.at < TTL_MS;
  }

  /** Reads with `read` and keeps the answer unless the settings changed meanwhile. */
  private async remember<T>(
    map: Map<string, Cached<T>>,
    key: string,
    read: () => Promise<T | null>,
  ): Promise<T | null> {
    const hit = map.get(key);
    if (this.fresh(hit)) return hit.value;
    const began = this.generation;
    const value = await read();
    if (value !== null && began === this.generation) map.set(key, { value, at: Date.now() });
    else map.delete(key);
    return value;
  }

  /** An organisation's id by slug. */
  tenantIdBySlug(slug: string): Promise<string | null> {
    const key = slug.toLowerCase();
    return this.remember(this.idBySlug, key, () => this.db.tenantIdBySlug(key));
  }

  /** Whether organisations use the deployment's directory (ENTRA_*) instead of their own. */
  get usesDeployment(): boolean {
    return this.deployment !== null;
  }

  /** The deployment's directory without the secret, when it has one. */
  deploymentDirectory(): {
    entraTenantId: string;
    clientId: string;
    allowedDomains: string[];
  } | null {
    const d = this.deployment;
    return d
      ? { entraTenantId: d.entraTenantId, clientId: d.clientId, allowedDomains: d.allowedDomains }
      : null;
  }

  /** An organisation's start settings, with the deployment's directory in place of its own. */
  private withDirectory(c: SsoStartConfig): SsoStartConfig {
    const d = this.deployment;
    return d ? { ...c, entraTenantId: d.entraTenantId, clientId: d.clientId } : c;
  }

  /** What starting a sign-in to the organisation `slug` needs (public settings, no secret). */
  async startBySlug(slug: string): Promise<SsoStartConfig | null> {
    const key = slug.toLowerCase();
    const row = await this.remember(this.startSlugs, key, () => this.db.ssoConfigBySlug(key));
    return row ? this.withDirectory(row) : null;
  }

  /** What starting a sign-in for an e-mail domain needs, or 'ambiguous'. */
  async startByDomain(domain: string): Promise<SsoStartConfig | 'ambiguous' | null> {
    const d = domain.toLowerCase();
    const wanted = this.deployment?.allowedDomains;
    if (wanted?.length && !wanted.includes(d)) return null;
    const matches = await this.db.ssoTenantsForDomain(d);
    if (matches.length > 1) return 'ambiguous';
    return matches[0] ? this.withDirectory(matches[0]) : null;
  }

  /** The whole configuration, secret included, for finishing a sign-in. */
  async forTenant(tenantId: string): Promise<SsoConfig | null> {
    const hit = this.byTenant.get(tenantId);
    const row = this.fresh(hit) ? hit.value : await this.readRow(tenantId);
    const d = this.deployment;
    if (!row || !d) return row;
    return {
      ...row,
      entraTenantId: d.entraTenantId,
      clientId: d.clientId,
      clientSecret: await this.secrets.resolve(d.secret),
      allowedDomains: this.domainsOf(row.allowedDomains),
      fromDeployment: true,
    };
  }

  /** An organisation's own row, secret decrypted (the deployment's directory is put on top). */
  private async readRow(tenantId: string): Promise<SsoConfig | null> {
    const began = this.generation;
    const row = await this.db.withTenant(tenantId, (tx) => this.identity.sso(tx, tenantId));
    const value: SsoConfig | null = row
      ? {
          tenantId,
          entraTenantId: row.entraTenantId,
          clientId: row.clientId,
          clientSecret: row.clientSecretEnc
            ? decryptField(row.clientSecretEnc, this.config.ENCRYPTION_KEY)
            : null,
          enabled: row.enabled,
          enforceSso: row.enforceSso,
          autoProvision: row.autoProvision,
          allowedDomains: row.allowedDomains,
          fromDeployment: false,
        }
      : null;
    if (began === this.generation) this.byTenant.set(tenantId, { value, at: Date.now() });
    return value;
  }

  /** Which of these organisations require Microsoft sign-in, and through which directory. */
  async enforced(tenantIds: string[]): Promise<{ tenantId: string; entraTenantId: string }[]> {
    const rows = await this.db.ssoEnforcedTenants(tenantIds);
    const d = this.deployment;
    return d ? rows.map((r) => ({ ...r, entraTenantId: d.entraTenantId })) : rows;
  }

  /** After an organisation's settings are saved (committed): every process forgets them. */
  async changed(tenantId: string): Promise<void> {
    this.forget(tenantId);
    await this.bus.publish(CHANNEL, { tenantId });
  }

  private forget(tenantId: string) {
    this.generation++;
    this.byTenant.delete(tenantId);
    for (const [slug, hit] of this.startSlugs)
      if (hit.value.tenantId === tenantId) this.startSlugs.delete(slug);
  }
}
