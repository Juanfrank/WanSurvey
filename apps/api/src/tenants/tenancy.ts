import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';
import { Engine } from '../db/engine.js';

/** The single-tenant mode found several organisations: the process does not start. */
export class SingleTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SingleTenantError';
  }
}

/**
 * The organisation a single-tenant installation serves, from the organisations in the database:
 * the only one; null while there is none yet (a new installation: the first is made as always).
 * Several cannot be served by one: that is a configuration to fix, not a choice to guess.
 */
export function pickSingleTenant(tenantIds: readonly string[]): string | null {
  if (tenantIds.length > 1)
    throw new SingleTenantError(
      `SINGLE_TENANT=true, but the database has ${tenantIds.length} organisations: the mode serves one; turn it off (SINGLE_TENANT=false) or keep a single organisation in the database`,
    );
  return tenantIds[0]?.toLowerCase() ?? null;
}

/** Said by every route that exists only because there may be several organisations. */
export const notInSingleTenant = () =>
  new NotFoundException({
    code: 'SINGLE_TENANT',
    message: 'Not available: this installation serves a single organisation',
  });

/**
 * Whether the installation serves one organisation (SINGLE_TENANT) and which. It is found at the
 * start, where several organisations stop the process with the reason. On a new installation with
 * none yet it is looked for again until the first appears, and then kept: one made after it is
 * never served (and the next start refuses the database).
 */
@Injectable()
export class Tenancy implements OnApplicationBootstrap {
  private readonly logger = new Logger('Tenancy');
  private resolved: string | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly engine: Engine,
  ) {}

  get single(): boolean {
    return this.config.SINGLE_TENANT;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.single) return;
    // Here a SingleTenantError stops the start (main.ts says it as a configuration error).
    this.resolved = pickSingleTenant(await this.engine.allTenantIds());
    if (this.resolved) this.logger.log(`Single-tenant mode: serving organisation ${this.resolved}`);
    else
      this.logger.warn(
        'Single-tenant mode: the database has no organisation yet (INITIAL_ADMIN_USER makes the first)',
      );
  }

  /** The organisation served in single-tenant mode (null with none yet, or in the other mode). */
  async tenantId(): Promise<string | null> {
    if (!this.single) return null;
    if (this.resolved) return this.resolved;
    try {
      this.resolved = pickSingleTenant(await this.engine.allTenantIds());
    } catch (e) {
      if (!(e instanceof SingleTenantError)) throw e;
      // Several appeared at once after the start on an empty database: none is guessed.
      this.logger.error(e.message);
      throw new ServiceUnavailableException({
        code: 'SINGLE_TENANT_AMBIGUOUS',
        message: e.message,
      });
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
