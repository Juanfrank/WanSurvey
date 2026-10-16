import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
  Headers,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { Public } from '../common/auth-context.js';
import { safeEqual } from '../common/crypto.js';
import { ZodPipe } from '../common/zod.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Inject } from '@nestjs/common';
import { DeviceId, SubmitBody } from '../interviews/schemas.js';
import { CawiService, RespondentSync, WebhookBody } from './cawi.service.js';

/** Respondents act through their link; each address gets a fair share of requests. */
const respondentLimit = { default: { limit: 120, ttl: 60_000 } };

/** 1×1 transparent GIF. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** `params` is the link's own query string (`sede=2&…`), kept with the interview. */
const DeviceQuery = z.object({ device: DeviceId, params: z.string().max(2000).optional() });

/**
 * Everything that works without signing in: the respondent's survey (the link token is the
 * credential, W1), open links, tracking, unsubscribing, and the mail provider's webhook.
 */
@ApiTags('public')
@Controller()
export class PublicSurveyController {
  constructor(
    private readonly cawi: CawiService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Throttle(respondentLimit)
  @Get('public/s/:token')
  get(
    @Param('token') token: string,
    @Query(new ZodPipe(DeviceQuery)) q: z.infer<typeof DeviceQuery>,
  ) {
    return this.cawi.respondent(token, q.device, q.params);
  }

  @Public()
  @Throttle(respondentLimit)
  @Post('public/s/:token/sync')
  @HttpCode(200)
  @ApiBody({ schema: z.toJSONSchema(RespondentSync, { io: 'input' }) as object })
  sync(
    @Param('token') token: string,
    @Body(new ZodPipe(RespondentSync)) body: z.infer<typeof RespondentSync>,
  ) {
    return this.cawi.respondentSync(token, body);
  }

  @Public()
  @Throttle(respondentLimit)
  @Post('public/s/:token/submit')
  @HttpCode(200)
  @ApiBody({ schema: z.toJSONSchema(SubmitBody) as object })
  submit(@Param('token') token: string, @Body(new ZodPipe(SubmitBody)) body: SubmitBody) {
    return this.cawi.respondentSubmit(token, body);
  }

  /** Starts an anonymous interview from an open link. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('public/o/:slug/start')
  @HttpCode(200)
  openLink(@Param('slug') slug: string) {
    return this.cawi.openLinkStart(slug);
  }

  /** Open pixel (approximate, W2). Always answers with the image. */
  @Public()
  @Get('t/o/:file')
  @Header('Content-Type', 'image/gif')
  @Header('Cache-Control', 'no-store')
  async open(@Param('file') file: string, @Res() res: Response) {
    await this.cawi.track(file.replace(/\.gif$/, ''), 'open');
    res.end(PIXEL);
  }

  /** Link in the e-mail: records the click and goes to the survey. */
  @Public()
  @Get('t/c/:token')
  async click(@Param('token') token: string, @Res() res: Response) {
    res.redirect(302, await this.cawi.track(token, 'click'));
  }

  @Public()
  @Throttle(respondentLimit)
  @Get('public/u/:token')
  unsubscribeInfo(@Param('token') token: string) {
    return this.cawi.unsubscribeInfo(token);
  }

  @Public()
  @Throttle(respondentLimit)
  @Post('public/u/:token')
  @HttpCode(200)
  unsubscribe(@Param('token') token: string) {
    return this.cawi.unsubscribe(token);
  }

  /** Delivery events from the mail provider, authenticated by a shared secret (W3). */
  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('webhooks/mail')
  @HttpCode(200)
  @ApiBody({ schema: z.toJSONSchema(WebhookBody) as object })
  webhook(
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body(new ZodPipe(WebhookBody)) body: z.infer<typeof WebhookBody>,
  ) {
    const expected = this.config.MAIL_WEBHOOK_SECRET;
    if (!expected || !secret || !safeEqual(secret, expected))
      throw new UnauthorizedException({ code: 'BAD_SECRET', message: 'Invalid webhook secret' });
    return this.cawi.webhook(body);
  }
}
