import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth-context.js';
import { Database } from '../db/database.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly database: Database) {}

  @Public()
  @Get()
  async health() {
    if (!(await this.database.probe()))
      throw new ServiceUnavailableException({ status: 'error', db: false });
    return { status: 'ok', db: true };
  }
}
