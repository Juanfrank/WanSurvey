import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import { telemetry } from './app-insights.js';

/**
 * Gives every failure on the server's side (an error nobody handled, or an HttpException of 5xx) to
 * the error reporting, and lets Nest answer as it always did. A 4xx is the caller's fault and is not
 * reported. Only the method and the route pattern go with it, never the address, query, body or
 * headers.
 */
@Catch()
export class ReportingFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500 && host.getType() === 'http') {
      const req = host.switchToHttp().getRequest<Request>();
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      telemetry.trackException(exception, { method: req.method, route, status: String(status) });
    }
    super.catch(exception, host);
  }
}
