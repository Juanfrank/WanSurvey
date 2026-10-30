import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth-context.js';
import { Engine } from '../db/engine.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly engine: Engine) {}

  @Public()
  @Get()
  async health() {
    if (!(await this.engine.probe()))
      throw new ServiceUnavailableException({ status: 'error', db: false });
    return { status: 'ok', db: true };
  }
}
