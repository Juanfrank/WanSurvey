import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { WEBHOOK_EVENTS } from './outbox.js';
import { WebhooksService } from './webhooks.service.js';

const Events = z.array(z.enum(WEBHOOK_EVENTS)).min(1);
const Create = z.strictObject({
  url: z.string().trim().url().max(1000),
  events: Events,
  projectId: z.uuid().nullable().default(null),
});
const Patch_ = z.strictObject({
  url: z.string().trim().url().max(1000).optional(),
  events: Events.optional(),
  enabled: z.boolean().optional(),
});

/** Webhook endpoints of the organisation, for whoever manages the integrations. */
@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly svc: WebhooksService) {}

  @Get()
  @RequirePermission('apikeys.manage')
  list(@Auth() ctx: AuthContext) {
    return this.svc.list(ctx);
  }

  /** The signing secret is in the answer of this call only. */
  @Post()
  @RequirePermission('apikeys.manage')
  create(@Auth() ctx: AuthContext, @Body(new ZodPipe(Create)) body: z.infer<typeof Create>) {
    return this.svc.create(ctx, body);
  }

  @Patch(':id')
  @HttpCode(204)
  @RequirePermission('apikeys.manage')
  async update(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(Patch_)) body: z.infer<typeof Patch_>,
  ) {
    await this.svc.update(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('apikeys.manage')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.svc.remove(ctx, id);
  }

  @Post(':id/rotate-secret')
  @RequirePermission('apikeys.manage')
  rotate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.rotate(ctx, id);
  }

  @Post(':id/test')
  @HttpCode(204)
  @RequirePermission('apikeys.manage')
  async test(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.svc.test(ctx, id);
  }

  @Get(':id/deliveries')
  @RequirePermission('apikeys.manage')
  deliveries(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.deliveries(ctx, id);
  }

  @Post('deliveries/:deliveryId/redeliver')
  @HttpCode(204)
  @RequirePermission('apikeys.manage')
  async redeliver(
    @Auth() ctx: AuthContext,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ) {
    await this.svc.redeliver(ctx, deliveryId);
  }
}
