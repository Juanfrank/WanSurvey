import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AboutFacts, TechnicalFacts } from '@wansurvey/schema';
import { Public } from '../common/auth-context.js';
import { CONFIG, type AppConfig } from '../config.js';
import { VERSION } from '../version.js';

/**
 * What the public About, Privacy and Terms pages need to say about this installation: the version,
 * who runs it and who answers for the personal data, the author and holder of the application,
 * and which optional services are switched on (a policy must not claim what is off, nor hide
 * what is on). Nothing operational: no build, no environment, no paths (see `SystemController`).
 */
@ApiTags('about')
@Controller('public/about')
export class AboutController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Get()
  about(): AboutFacts {
    const c = this.config;
    return {
      version: VERSION,
      organisation: c.ORG_NAME || null,
      privacyContact: c.PRIVACY_CONTACT || null,
      author: c.APP_AUTHOR || null,
      holder: c.APP_HOLDER || null,
      services: {
        geocoder: c.GEOCODER !== 'none',
        sms: c.SMS_PROVIDER === 'acs',
        email: c.MAILER === 'smtp',
        microsoftSignIn: !!c.ENTRA_CLIENT_ID,
        passwordLogin: c.PASSWORD_LOGIN,
      },
    };
  }
}

/** For people with a session only: the build and mode, shown at the end of the About page. */
@ApiTags('about')
@Controller('system')
export class SystemController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  @Get('technical')
  technical(): TechnicalFacts {
    return {
      build: this.config.APP_BUILD || VERSION,
      environment: this.config.NODE_ENV === 'production' ? 'production' : 'development',
      node: process.versions.node,
    };
  }
}
