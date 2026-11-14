import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth-context.js';
import { CONFIG, type AppConfig } from '../config.js';
import { VERSION } from '../version.js';

/**
 * What the public About and Privacy pages need to say about this installation: the version,
 * who answers for the personal data and where to write, and which optional outside services
 * are switched on (a policy must not claim what is off, nor hide what is on).
 */
@ApiTags('about')
@Controller('public/about')
export class AboutController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Get()
  about() {
    const c = this.config;
    return {
      version: VERSION,
      organisation: c.ORG_NAME ?? null,
      privacyContact: c.PRIVACY_CONTACT ?? null,
      author: c.APP_AUTHOR || null,
      holder: c.APP_HOLDER || null,
      services: {
        geocoder: c.GEOCODER !== 'none',
        sms: c.SMS_PROVIDER === 'acs',
        microsoftSignIn: !!c.ENTRA_CLIENT_ID,
      },
    };
  }
}
