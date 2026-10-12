import { Logger } from '@nestjs/common';
import type { AppConfig } from './config.js';

/**
 * OpenTelemetry and Sentry hooks. They are configuration-gated and not yet wired to exporters
 * (planned for slice 13, hardening); this keeps the call site stable.
 */
export function initObservability(config: AppConfig): void {
  const logger = new Logger('Observability');
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT)
    logger.warn('OTEL_EXPORTER_OTLP_ENDPOINT is set but tracing is not wired yet');
  if (config.SENTRY_DSN) logger.warn('SENTRY_DSN is set but error reporting is not wired yet');
}
