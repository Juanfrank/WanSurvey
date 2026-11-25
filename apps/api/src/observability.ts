import { Logger } from '@nestjs/common';
import type { AppConfig } from './config.js';
import { telemetry } from './observability/app-insights.js';
import { VERSION } from './version.js';

/**
 * Error reporting (Azure Application Insights, when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set) and
 * the handlers of what nobody handled. `role` names the process in Application Insights.
 */
export function initObservability(config: AppConfig, role: 'api' | 'worker' = 'api'): void {
  const logger = new Logger('Observability');
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT)
    logger.warn('OTEL_EXPORTER_OTLP_ENDPOINT is set but tracing is not wired yet');
  if (config.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    if (
      telemetry.init({
        connectionString: config.APPLICATIONINSIGHTS_CONNECTION_STRING,
        role: `wansurvey-${role}`,
        version: VERSION,
      })
    )
      logger.log('Failures are reported to Application Insights (without personal data)');
    else
      logger.warn('APPLICATIONINSIGHTS_CONNECTION_STRING is not a connection string: no reporting');
  }
  // What is still waiting goes out before the process ends.
  process.once('beforeExit', () => void telemetry.flush());
  // A promise nobody awaited (a lost notification, a dropped connection) is logged instead of
  // ending the process, which Node does by default; an exception thrown outside any handler
  // leaves the state unknown, so the process exits and the host starts a fresh one.
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
    telemetry.trackException(reason, { kind: 'unhandledRejection' });
  });
  process.on('uncaughtException', (e) => {
    logger.fatal(`Uncaught exception: ${e.stack ?? e.message}`);
    telemetry.trackException(e, { kind: 'uncaughtException' }, 4);
    process.exitCode = 1;
    // The report gets a moment to leave, then the process ends.
    void telemetry.flush(1_000).finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 1_500).unref();
  });
}
