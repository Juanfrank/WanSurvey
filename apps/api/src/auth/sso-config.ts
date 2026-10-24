import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { decryptField } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database } from '../db/database.js';
import { tenantSso } from '../db/schema.js';

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

/** How long a configuration read from the database is reused by this process. */
const TTL_MS = 60_000;

/**
 * Where each organisation's Microsoft sign-in comes from, read once a minute per process
 * instead of on every sign-in (at the start of a field day hundreds come within minutes).
 * The default organisation (SSO_DEFAULT_ORG) takes it from the deployment when ENTRA_* are
 * set: with password sign-in off, nobody could sign in to configure it in the app.
 */
@Injectable()
export class SsoConfigs {
  private readonly byTenant = new Map<string, { value: SsoConfig | null; at: number }>();
  private readonly bySlug = new Map<string, { value: string | null; at: number }>();

  constructor(
    private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** The deployment's configuration, when complete. */
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

  /** An organisation's id by slug (cached). */
  async tenantIdBySlug(slug: string): Promise<string | null> {
    const key = slug.toLowerCase();
    const hit = this.bySlug.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.database.tenantIdBySlug(key);
    this.bySlug.set(key, { value, at: Date.now() });
    return value;
  }

  /** The default organisation's id, when SSO_DEFAULT_ORG is set. */
  async defaultTenantId(): Promise<string | null> {
    return this.config.SSO_DEFAULT_ORG ? this.tenantIdBySlug(this.config.SSO_DEFAULT_ORG) : null;
  }

  async forTenant(tenantId: string): Promise<SsoConfig | null> {
    const d = this.deployment;
    if (d && tenantId === (await this.tenantIdBySlug(d.slug))) {
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
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
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
    this.byTenant.set(tenantId, { value, at: Date.now() });
    return value;
  }

  /** The organisation whose people sign in with this e-mail domain, if the deployment's. */
  async deploymentTenantForDomain(domain: string): Promise<string | null> {
    const d = this.deployment;
    return d && d.allowedDomains.includes(domain.toLowerCase())
      ? this.tenantIdBySlug(d.slug)
      : null;
  }

  /** After the organisation's settings change (other processes catch up within a minute). */
  invalidate(tenantId: string) {
    this.byTenant.delete(tenantId);
  }
}
