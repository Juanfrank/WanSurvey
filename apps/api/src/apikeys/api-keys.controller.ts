import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { ApiKeyBody } from '@wansurvey/schema';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { ApiKeysService } from './api-keys.service.js';

/** Keys of the integration API, for the people who manage them (not for the keys themselves). */
@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @RequirePermission('apikeys.manage')
  list(@Auth() ctx: AuthContext) {
    return this.keys.list(ctx);
  }

  /** The key itself is in the answer of this call only. */
  @Post()
  @RequirePermission('apikeys.manage')
  @ApiBody({ schema: z.toJSONSchema(ApiKeyBody, { unrepresentable: 'any' }) as object })
  create(@Auth() ctx: AuthContext, @Body(new ZodPipe(ApiKeyBody)) body: ApiKeyBody) {
    return this.keys.create(ctx, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('apikeys.manage')
  async revoke(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.keys.revoke(ctx, id);
  }
}
