import { Body, Controller, Delete, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { PUSH_CATEGORIES } from './outbox.js';
import { PushService } from './push.service.js';

const Subscribe = z.strictObject({
  endpoint: z.string().url().max(1000),
  keys: z.strictObject({ p256dh: z.string().min(80).max(100), auth: z.string().min(20).max(30) }),
  categories: z.array(z.enum(PUSH_CATEGORIES)).max(PUSH_CATEGORIES.length),
  lang: z.string().min(2).max(8).default('es'),
  userAgent: z.string().max(300).optional(),
});
const Endpoint = z.strictObject({ endpoint: z.string().url().max(1000) });

/** Web notifications of the signed-in person: this browser's subscription and its categories. */
@ApiTags('push')
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('config')
  config() {
    return this.push.clientConfig();
  }

  @Get('subscription')
  state(@Auth() ctx: AuthContext, @Query(new ZodPipe(Endpoint)) q: z.infer<typeof Endpoint>) {
    return this.push.state(ctx, q.endpoint);
  }

  @Put('subscription')
  @HttpCode(204)
  async subscribe(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(Subscribe)) body: z.infer<typeof Subscribe>,
  ) {
    await this.push.subscribe(ctx, body);
  }

  @Delete('subscription')
  @HttpCode(204)
  async unsubscribe(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(Endpoint)) body: z.infer<typeof Endpoint>,
  ) {
    await this.push.unsubscribe(ctx, body.endpoint);
  }

  @Post('test')
  @HttpCode(204)
  async test(@Auth() ctx: AuthContext) {
    await this.push.test(ctx);
  }
}
