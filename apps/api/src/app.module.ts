import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { SsoController, SsoSettingsController } from './auth/sso.controller.js';
import { SsoService } from './auth/sso.service.js';
import { CONFIG, loadConfig } from './config.js';
import { Database } from './db/database.js';
import { HealthController } from './health/health.controller.js';
import { ConsoleMailer, MAILER, MemoryMailer, type Mailer } from './mail/mailer.js';
import { ProjectsController } from './projects/projects.controller.js';
import { TenantsController } from './tenants/tenants.controller.js';
import { UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';

export interface AppModuleOptions {
  mailer?: Mailer;
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
        AuditController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: MAILER,
          useValue:
            opts.mailer ?? (config.NODE_ENV === 'test' ? new MemoryMailer() : new ConsoleMailer()),
        },
        Database,
        AuditService,
        AuthService,
        SsoService,
        UsersService,
        // Order matters: rate limiting first, then authentication/authorisation.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
