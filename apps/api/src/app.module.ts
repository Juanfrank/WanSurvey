import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { CapiController } from './capi/capi.controller.js';
import { CapiService } from './capi/capi.service.js';
import { CawiController } from './cawi/cawi.controller.js';
import { CawiService } from './cawi/cawi.service.js';
import { WaveDispatcher } from './cawi/dispatcher.js';
import { PublicSurveyController } from './cawi/public.controller.js';
import { PapiController } from './papi/papi.controller.js';
import { PapiService } from './papi/papi.service.js';
import { CatiController } from './cati/cati.controller.js';
import { CatiService } from './cati/cati.service.js';
import { CasesController } from './cases/cases.controller.js';
import { CasesService } from './cases/cases.service.js';
import { ImportsController } from './cases/imports.controller.js';
import { SsoController, SsoSettingsController } from './auth/sso.controller.js';
import { SsoService } from './auth/sso.service.js';
import { CONFIG, loadConfig } from './config.js';
import { Database } from './db/database.js';
import { HealthController } from './health/health.controller.js';
import {
  ConsoleMailer,
  FileMailer,
  MAILER,
  MemoryMailer,
  SmtpMailer,
  type Mailer,
} from './mail/mailer.js';
import { ProjectsController } from './projects/projects.controller.js';
import { GeoController } from './geo/geo.controller.js';
import { InterviewsController } from './interviews/interviews.controller.js';
import { InterviewsService } from './interviews/interviews.service.js';
import { GEOCODER, NominatimGeocoder, type Geocoder } from './geo/geocoder.js';
import { GeoService } from './geo/geo.service.js';
import { LibraryController } from './library/library.controller.js';
import { CollabController } from './questionnaires/collab.controller.js';
import { QuestionnairesController } from './questionnaires/questionnaires.controller.js';
import { TenantsController } from './tenants/tenants.controller.js';
import { UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';

export interface AppModuleOptions {
  mailer?: Mailer;
  /** Replaces the configured geocoder (tests use a mock Nominatim). */
  geocoder?: Geocoder | null;
}

@Module({})
export class AppModule {
  static register(opts: AppModuleOptions = {}): DynamicModule {
    const config = loadConfig();
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            redact: [
              'req.headers.cookie',
              'req.headers["x-csrf-token"]',
              'res.headers["set-cookie"]',
            ],
          },
        }),
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }]),
      ],
      controllers: [
        HealthController,
        AuthController,
        SsoController,
        SsoSettingsController,
        UsersController,
        TenantsController,
        ProjectsController,
        QuestionnairesController,
        CollabController,
        LibraryController,
        GeoController,
        InterviewsController,
        CatiController,
        CapiController,
        CawiController,
        PublicSurveyController,
        PapiController,
        CasesController,
        ImportsController,
        AuditController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: MAILER,
          useValue:
            opts.mailer ??
            (config.NODE_ENV === 'test'
              ? new MemoryMailer()
              : config.MAILER === 'file'
                ? new FileMailer(config.MAIL_OUTBOX_DIR!)
                : config.MAILER === 'smtp'
                  ? new SmtpMailer(config.SMTP_URL!, config.MAIL_FROM)
                  : new ConsoleMailer()),
        },
        Database,
        AuditService,
        AuthService,
        SsoService,
        UsersService,
        CasesService,
        GeoService,
        InterviewsService,
        CatiService,
        CapiService,
        CawiService,
        WaveDispatcher,
        PapiService,
        {
          provide: GEOCODER,
          useValue:
            opts.geocoder !== undefined
              ? opts.geocoder
              : config.GEOCODER === 'nominatim'
                ? new NominatimGeocoder(config.GEOCODER_URL, config.GEOCODER_EMAIL!)
                : null,
        },
        // Order matters: rate limiting first, then authentication/authorisation.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
