import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { decryptField } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database, type SsoPublicConfig } from '../db/database.js';
import { tenantSso } from '../db/schema.js';
import { BUS, type Bus } from '../jobs/bus.js';

/** An organisation's Microsoft sign-in, ready to use (the secret decrypted). */
export interface SsoConfig {
  tenantId: string;
  entraTenantId: string;
  clientId: string;
  clientSecret: string | null;
  enabled: boolean;
  enforceSso: boolean;
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
 * fallback if the bus is down. The default organisation (SSO_DEFAULT_ORG) takes it from the
 * deployment when ENTRA_* are set: with password sign-in off, nobody could sign in to
 * configure it in the app.
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
    private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BUS) private readonly bus: Bus,
  ) {
    this.unsubscribe = bus.subscribe(CHANNEL, (m) => {
      if (typeof m.tenantId === 'string') this.forget(m.tenantId);
    });
  }

  onModuleDestroy() {
    this.unsubscribe();
  }

  /** The deployment's configuration, when complete (the configuration checks it is whole). */
  private get deployment() {
    const c = this.config;
    return c.SSO_DEFAULT_ORG && c.ENTRA_TENANT_ID && c.ENTRA_CLIENT_ID && c.ENTRA_CLIENT_SECRET
      ? {
          slug: c.SSO_DEFAULT_ORG.toLowerCase(),
          entraTenantId: c.ENTRA_TENANT_ID.toLowerCase(),
          clientId: c.ENTRA_CLIENT_ID.toLowerCase(),
          clientSecret: c.ENTRA_CLIENT_SECRET,
          allowedDomains: c.ENTRA_ALLOWED_DOMAINS,
        }
      : null;
  }

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
    return this.remember(this.idBySlug, key, () => this.database.tenantIdBySlug(key));
  }

  /** The default organisation's id, when SSO_DEFAULT_ORG is set. */
  async defaultTenantId(): Promise<string | null> {
    return this.config.SSO_DEFAULT_ORG ? this.tenantIdBySlug(this.config.SSO_DEFAULT_ORG) : null;
  }

  /** Whether this organisation's sign-in comes from the deployment's settings. */
  async isDeploymentTenant(tenantId: string): Promise<boolean> {
    const d = this.deployment;
    return !!d && tenantId === (await this.tenantIdBySlug(d.slug));
  }

  /** The deployment's sign-in settings without the secret, when it has them. */
  async deploymentSettings() {
    const d = this.deployment;
    const tenantId = d ? await this.tenantIdBySlug(d.slug) : null;
    return d && tenantId
      ? {
          tenantId,
          entraTenantId: d.entraTenantId,
          clientId: d.clientId,
          enabled: true,
          enforceSso: true,
          allowedDomains: d.allowedDomains,
        }
      : null;
  }

  /** What starting a sign-in to the organisation `slug` needs (public settings, no secret). */
  async startBySlug(slug: string): Promise<SsoStartConfig | null> {
    const key = slug.toLowerCase();
    if (this.deployment?.slug === key) return this.deploymentSettings();
    return this.remember(this.startSlugs, key, () => this.database.ssoConfigBySlug(key));
  }

  /** What starting a sign-in for an e-mail domain needs, or 'ambiguous'. */
  async startByDomain(domain: string): Promise<SsoStartConfig | 'ambiguous' | null> {
    const d = domain.toLowerCase();
    if (this.deployment?.allowedDomains.includes(d)) return this.deploymentSettings();
    const matches = await this.database.ssoTenantsForDomain(d);
    if (matches.length > 1) return 'ambiguous';
    return matches[0] ?? null;
  }

  /** The whole configuration, secret included, for finishing a sign-in. */
  async forTenant(tenantId: string): Promise<SsoConfig | null> {
    const d = this.deployment;
    if (d && (await this.isDeploymentTenant(tenantId))) {
      return {
        tenantId,
        entraTenantId: d.entraTenantId,
        clientId: d.clientId,
        clientSecret: d.clientSecret,
        enabled: true,
        enforceSso: true,
        allowedDomains: d.allowedDomains,
        fromDeployment: true,
      };
    }
    const hit = this.byTenant.get(tenantId);
    if (this.fresh(hit)) return hit.value;
    const began = this.generation;
    const row = await this.database.withTenant(tenantId, async (tx) => {
      const [r] = await tx.select().from(tenantSso).where(eq(tenantSso.tenantId, tenantId));
      return r;
    });
    const value: SsoConfig | null = row
      ? {
          tenantId,
          entraTenantId: row.entraTenantId,
          clientId: row.clientId,
          clientSecret: row.clientSecretEnc
            ? decryptField(row.clientSecretEnc, this.config.APP_ENCRYPTION_KEY)
            : null,
          enabled: row.enabled,
          enforceSso: row.enforceSso,
          allowedDomains: row.allowedDomains,
          fromDeployment: false,
        }
      : null;
    if (began === this.generation) this.byTenant.set(tenantId, { value, at: Date.now() });
    return value;
  }

  /** Which of these organisations require Microsoft sign-in, and through which directory. */
  async enforced(tenantIds: string[]): Promise<{ tenantId: string; entraTenantId: string }[]> {
    const rows = await this.database.ssoEnforcedTenants(tenantIds);
    const d = this.deployment;
    const own = d ? await this.tenantIdBySlug(d.slug) : null;
    if (!d || !own || !tenantIds.includes(own)) return rows;
    return [
      ...rows.filter((r) => r.tenantId !== own),
      { tenantId: own, entraTenantId: d.entraTenantId },
    ];
  }

  /** The organisation whose people sign in with this e-mail domain, if the deployment's. */
  async deploymentTenantForDomain(domain: string): Promise<string | null> {
    const d = this.deployment;
    return d && d.allowedDomains.includes(domain.toLowerCase())
      ? this.tenantIdBySlug(d.slug)
      : null;
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
