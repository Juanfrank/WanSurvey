import { Controller, Get, Inject, NotFoundException, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { orgTheme } from '@wansurvey/schema';
import type { Response } from 'express';
import { Public } from '../common/auth-context.js';
import { ORG_REPO, type OrgRepo } from '../projects/org-repo.js';
import { logoUrl, sendLogo } from './org-logo.js';
import { Tenancy } from './tenancy.js';

const lookLimit = { default: { limit: 120, ttl: 60_000 } };

/** Outside single-tenant mode the sign-in page does not know the organisation: nothing to say. */
const notHere = () =>
  new NotFoundException({
    code: 'NOT_SINGLE_TENANT',
    message: 'The organisation is known only after signing in',
  });

/**
 * The look of the one organisation an installation serves (SINGLE_TENANT), for the pages before
 * signing in: its colours and its logo, nothing else (no name, no settings). With several
 * organisations these routes answer 404, as the sign-in page cannot know which one it is.
 */
@ApiTags('tenant')
@Controller('public/org-look')
export class OrgLookController {
  constructor(
    @Inject(ORG_REPO) private readonly repo: OrgRepo,
    private readonly tenancy: Tenancy,
  ) {}

  @Public()
  @Throttle(lookLimit)
  @Get()
  async look() {
    if (!this.tenancy.single) throw notHere();
    const tenantId = await this.tenancy.tenantId();
    // A new installation with no organisation yet: the interface as it ships.
    const tenant = tenantId ? await this.repo.inTenant(tenantId, (t) => t.tenant()) : null;
    const theme = orgTheme(tenant?.branding);
    return {
      theme,
      logo: tenant?.logo
        ? { url: logoUrl('public/org-look/logo', tenant.logo.updatedAt), alt: tenant.logo.alt }
        : null,
    };
  }

  @Public()
  @Throttle(lookLimit)
  @Get('logo')
  async logo(@Res() res: Response) {
    if (!this.tenancy.single) throw notHere();
    const tenantId = await this.tenancy.tenantId();
    const logo = tenantId ? await this.repo.inTenant(tenantId, (t) => t.tenantLogo()) : null;
    if (!logo) throw new NotFoundException('No logo');
    sendLogo(res, logo, 'public');
  }
}
