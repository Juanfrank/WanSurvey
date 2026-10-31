import { SamplingController } from './sampling/sampling.controller.js';
import { SamplingService } from './sampling/sampling.service.js';
import { FeedbackController, PublicFeedbackController } from './feedback/feedback.controller.js';
import { FeedbackService } from './feedback/feedback.service.js';
import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
} from '@nestjs/common';
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
import { ScansController } from './papi/scans.controller.js';
import { ScansService } from './papi/scans.service.js';
import { AnalysisController, PublicShareController } from './analysis/analysis.controller.js';
import { GoalsController } from './metrics/goals.controller.js';
import { MssqlUsersRepo, USERS_REPO } from './users/users-repo.js';
import {
  MssqlQuestionnairesRepo,
  QUESTIONNAIRES_REPO,
} from './questionnaires/questionnaires-repo.js';
import { MssqlSampleRepo, SAMPLE_REPO } from './sampling/sampling-repo.js';
import { INTERVIEWS_REPO, MssqlInterviewsRepo } from './interviews/interviews-repo.js';
import { CATI_REPO, MssqlCatiRepo } from './cati/cati-repo.js';
import { MssqlReviewRepo, REVIEW_REPO } from './review/review-repo.js';
import { METRICS_REPO, MssqlMetricsRepo } from './metrics/metrics-repo.js';
import { LIVE_REPO, MssqlLiveRepo } from './dashboard/live-repo.js';
import { MssqlPrivacyRepo, PRIVACY_REPO } from './privacy/privacy-repo.js';
import { ANALYSIS_REPO, MssqlAnalysisRepo } from './analysis/analysis-repo.js';
import { TeamsController } from './teams/teams.controller.js';
import { MssqlTeamsRepo, TEAMS_REPO } from './teams/teams-repo.js';
import { ProjectPeopleController } from './projects/project-people.controller.js';
import { EXPORTS_REPO, MssqlExportsRepo } from './exports/exports-repo.js';
import { MssqlSweepRepo, SWEEP_REPO } from './jobs/sweep-repo.js';
import { CAWI_REPO, MssqlCawiRepo } from './cawi/cawi-repo.js';
import { FEEDBACK_REPO, MssqlFeedbackRepo } from './feedback/feedback-repo.js';
import { MssqlPapiRepo, PAPI_REPO } from './papi/papi-repo.js';
import { AnalysisService } from './analysis/analysis.service.js';
import { DatasetService } from './analysis/dataset.service.js';
import { ShareService } from './analysis/share.service.js';
import { LiveService } from './dashboard/live.service.js';
import { ExportsService } from './exports/exports.service.js';
import { EXPORT_STORAGE, exportStorage, type ExportStorage } from './exports/storage.js';
import { BUS, LocalBus, RedisBus, type Bus } from './jobs/bus.js';
import { JobsService, PROCESS_ROLE, type ProcessRole } from './jobs/jobs.service.js';
import { MetricsService } from './metrics/metrics.service.js';
import { BiService } from './stats/bi.service.js';
import { SweeperService } from './jobs/sweeper.service.js';
import { StatsService } from './stats/stats.service.js';
import { PrivacyController } from './privacy/privacy.controller.js';
import { ExpiryService } from './cases/expiry.service.js';
import { PrivacyService } from './privacy/privacy.service.js';
import { ReviewController } from './review/review.controller.js';
import { ReviewService } from './review/review.service.js';
import { CatiController } from './cati/cati.controller.js';
import { CatiService } from './cati/cati.service.js';
import { AssignmentRulesController } from './cases/assignment-rules.controller.js';
import { CasesController } from './cases/cases.controller.js';
import { CasesService } from './cases/cases.service.js';
import { CASES_REPO, MssqlCasesRepo } from './cases/cases-repo.js';
import { ImportsController } from './cases/imports.controller.js';
import { SsoController, SsoSettingsController } from './auth/sso.controller.js';
import { SsoConfigs } from './auth/sso-config.js';
import { SsoService } from './auth/sso.service.js';
import { CONFIG, loadConfig } from './config.js';
import { Engine } from './db/engine.js';
import { MssqlOrgRepo, ORG_REPO } from './projects/org-repo.js';
import { AUTH_REPO, MssqlAuthRepo } from './auth/auth-repo.js';
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
import { maskTokens } from './common/mask.js';
import { sessionOrIp, throttleStorage } from './common/throttle.js';

export interface AppModuleOptions {
  mailer?: Mailer;
  /** Replaces the configured geocoder (tests use a mock Nominatim). */
  geocoder?: Geocoder | null;
  /** The background worker runs the same services without HTTP (M1). */
  role?: ProcessRole;
  /** Replaces the configured bus (tests). */
  bus?: Bus;
  /** Replaces the configured export storage (tests: Azurite). */
  exportStorage?: ExportStorage;
}

const BUS_OWNED = Symbol('BUS_OWNED');

@Injectable()
class BusShutdown implements OnModuleDestroy {
  constructor(
    @Inject(BUS) private readonly bus: Bus,
    @Inject(BUS_OWNED) private readonly owned: boolean,
  ) {}

  async onModuleDestroy() {
    if (this.owned) await this.bus.close();
  }
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
            // Respondent, unsubscribe, tracking and share links carry tokens in their path.
            serializers: {
              req: (req: { url?: string }) => ({ ...req, url: maskTokens(req.url) }),
            },
          },
        }),
        // Per session (or IP on public routes) with the route's own limits, and an overall
        // ceiling per IP; counters shared through Redis when it is configured.
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'default', ttl: 60_000, limit: 600, getTracker: sessionOrIp },
            { name: 'ip', ttl: 60_000, limit: config.RATE_LIMIT_PER_IP },
          ],
          storage: throttleStorage(config.REDIS_URL),
        }),
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
        ScansController,
        ReviewController,
        AnalysisController,
        GoalsController,
        TeamsController,
        ProjectPeopleController,
        PublicShareController,
        PrivacyController,
        CasesController,
        AssignmentRulesController,
        ImportsController,
        AuditController,
        FeedbackController,
        PublicFeedbackController,
        SamplingController,
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
                  : new ConsoleMailer(config.NODE_ENV !== 'production')),
        },
        Engine,
        { provide: AUTH_REPO, useClass: MssqlAuthRepo },
        { provide: ORG_REPO, useClass: MssqlOrgRepo },
        { provide: TEAMS_REPO, useClass: MssqlTeamsRepo },
        { provide: USERS_REPO, useClass: MssqlUsersRepo },
        { provide: QUESTIONNAIRES_REPO, useClass: MssqlQuestionnairesRepo },
        { provide: CASES_REPO, useClass: MssqlCasesRepo },
        { provide: SAMPLE_REPO, useClass: MssqlSampleRepo },
        { provide: INTERVIEWS_REPO, useClass: MssqlInterviewsRepo },
        { provide: CATI_REPO, useClass: MssqlCatiRepo },
        { provide: REVIEW_REPO, useClass: MssqlReviewRepo },
        { provide: METRICS_REPO, useClass: MssqlMetricsRepo },
        { provide: LIVE_REPO, useClass: MssqlLiveRepo },
        { provide: PRIVACY_REPO, useClass: MssqlPrivacyRepo },
        { provide: ANALYSIS_REPO, useClass: MssqlAnalysisRepo },
        { provide: SWEEP_REPO, useClass: MssqlSweepRepo },
        { provide: CAWI_REPO, useClass: MssqlCawiRepo },
        { provide: FEEDBACK_REPO, useClass: MssqlFeedbackRepo },
        { provide: PAPI_REPO, useClass: MssqlPapiRepo },
        { provide: EXPORTS_REPO, useClass: MssqlExportsRepo },
        AuditService,
        AuthService,
        SsoService,
        SsoConfigs,
        UsersService,
        CasesService,
        GeoService,
        InterviewsService,
        CatiService,
        CapiService,
        CawiService,
        WaveDispatcher,
        PapiService,
        ScansService,
        ReviewService,
        { provide: PROCESS_ROLE, useValue: opts.role ?? 'api' },
        {
          provide: BUS,
          useFactory: () =>
            opts.bus ?? (config.REDIS_URL ? new RedisBus(config.REDIS_URL) : new LocalBus()),
        },
        // The bus this module made is closed with it (its Redis connections), a given one is not.
        { provide: BUS_OWNED, useValue: !opts.bus },
        BusShutdown,
        JobsService,
        StatsService,
        BiService,
        SweeperService,
        MetricsService,
        LiveService,
        DatasetService,
        AnalysisService,
        ExportsService,
        { provide: EXPORT_STORAGE, useValue: opts.exportStorage ?? exportStorage(config) },
        ShareService,
        PrivacyService,
        ExpiryService,
        FeedbackService,
        SamplingService,
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
