import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';
import { isUuid } from '../db/common.js';
import { Engine } from '../db/engine.js';

/** Single-tenant mode cannot tell which organisation to serve: the process does not start. */
export class SingleTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SingleTenantError';
  }
}

/** An organisation as single-tenant mode chooses among them. */
export interface TenantChoice {
  id: string;
  slug: string;
  createdAt: Date;
}

/**
 * The organisation a single-tenant installation serves, from the organisations in the database:
 * the one `wanted` names (slug or id; SINGLE_TENANT_ORG), else the oldest by creation. Null while
 * there is none yet (a new installation: the first is made as always). A `wanted` the database
 * does not have is a configuration to fix, not a choice to guess.
 */
export function pickSingleTenant(
  tenants: readonly TenantChoice[],
  wanted?: string | null,
): string | null {
  if (tenants.length === 0) return null;
  if (wanted) {
    const w = wanted.trim().toLowerCase();
    const found = tenants.find(
      (t) => (isUuid(w) && t.id.toLowerCase() === w) || t.slug.toLowerCase() === w,
    );
    if (!found)
      throw new SingleTenantError(
        `SINGLE_TENANT_ORG=${wanted}, but the database has no organisation with that slug or id; set it to the slug or id of an existing organisation, or leave it unset to serve the oldest`,
      );
    return found.id.toLowerCase();
  }
  const oldest = [...tenants].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  )[0]!;
  return oldest.id.toLowerCase();
}

/** The 503 of a SINGLE_TENANT_ORG that names none of the organisations that appeared. */
const isUnresolvable = (e: unknown) =>
  e instanceof ServiceUnavailableException &&
  (e.getResponse() as { code?: string }).code === 'SINGLE_TENANT_ORG';

/** Said by every route that exists only because there may be several organisations. */
export const notInSingleTenant = () =>
  new NotFoundException({
    code: 'SINGLE_TENANT',
    message: 'Not available: this installation serves a single organisation',
  });

/**
 * Whether the installation serves one organisation (SINGLE_TENANT) and which. It is found at the
 * start (SINGLE_TENANT_ORG, or the oldest); on a new installation with none yet it is looked for
 * again until the first appears, and then kept. Every other organisation is closed for as long as
 * the process runs: the database is fenced (`Engine.fence`), so sign-in, sessions, API keys,
 * public links and the worker's jobs never open them. Nothing about it is stored: without the
 * setting nothing is fenced.
 */
@Injectable()
export class Tenancy implements OnApplicationBootstrap {
  private readonly logger = new Logger('Tenancy');
  private resolved: string | null = null;
  /** Whether the start has looked (before it, a bad SINGLE_TENANT_ORG stops the start). */
  private started = false;
  /** A look in progress, shared by the callers meanwhile. */
  private looking: Promise<string | null> | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly engine: Engine,
  ) {
    // Before any job or request: the fence asks for the served organisation when first needed.
    // It fails closed: when the organisation cannot be told, nothing is opened (the reason is
    // logged, and the routes that ask `tenantId` themselves answer 503 with it).
    // A database that cannot be reached still fails as such (503, tried again later).
    if (this.single)
      engine.fence((tenantId) =>
        this.allows(tenantId).catch((e: unknown) => {
          if (e instanceof SingleTenantError || isUnresolvable(e)) return false;
          throw e;
        }),
      );
  }

  get single(): boolean {
    return this.config.SINGLE_TENANT;
  }

  private get wanted(): string | null {
    return this.config.SINGLE_TENANT_ORG ?? null;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.single) return;
    const all = await this.engine.everyTenant();
    // Here a SingleTenantError stops the start (main.ts says it as a configuration error).
    this.resolved = pickSingleTenant(all, this.wanted);
    this.started = true;
    if (!this.resolved) {
      this.logger.warn(
        this.wanted
          ? `Single-tenant mode: the database has no organisation yet; ${this.wanted} (SINGLE_TENANT_ORG) is served once it exists`
          : 'Single-tenant mode: the database has no organisation yet (INITIAL_ADMIN_USER makes the first)',
      );
      return;
    }
    const served = all.find((t) => t.id === this.resolved);
    const name = served ? `${served.slug} (${served.id})` : this.resolved;
    this.logger.log(`Single-tenant mode: serving organisation ${name}`);
    if (all.length > 1) {
      const closed = all.length - 1;
      const msg = `Single-tenant mode: the database has ${all.length} organisations; ${closed} other ${closed === 1 ? 'is' : 'are'} closed (sign-in, sessions, API keys, links and jobs) while the mode is on; their data is kept`;
      if (this.wanted) this.logger.log(msg);
      else
        this.logger.warn(
          `${msg}. SINGLE_TENANT_ORG is not set: serving the oldest, ${name}; set SINGLE_TENANT_ORG to the slug or id of the one to serve`,
        );
    }
  }

  /** The organisation served in single-tenant mode (null with none yet, or in the other mode). */
  async tenantId(): Promise<string | null> {
    if (!this.single) return null;
    if (this.resolved) return this.resolved;
    // With none served yet (a new installation), each call looks again; callers at the same
    // moment share one look.
    this.looking ??= this.look().finally(() => {
      this.looking = null;
    });
    return this.looking;
  }

  private async look(): Promise<string | null> {
    try {
      this.resolved = pickSingleTenant(await this.engine.everyTenant(), this.wanted);
      if (this.resolved)
        this.logger.log(`Single-tenant mode: serving organisation ${this.resolved}`);
    } catch (e) {
      // Before the start has looked, a bad SINGLE_TENANT_ORG stops the start as it would there.
      if (!(e instanceof SingleTenantError) || !this.started) throw e;
      // Organisations appeared after a start on an empty database, but not the one named.
      this.logger.error(e.message);
      throw new ServiceUnavailableException({ code: 'SINGLE_TENANT_ORG', message: e.message });
    }
    return this.resolved;
  }

  /** Whether an organisation may be opened here: any in the default mode, only the one otherwise. */
  async allows(tenantId: string): Promise<boolean> {
    if (!this.single) return true;
    return (await this.tenantId()) === tenantId.toLowerCase();
  }

  /** For the routes that exist only with several organisations: 404 in single-tenant mode. */
  refuseIfSingle(): void {
    if (this.single) throw notInSingleTenant();
  }
}
