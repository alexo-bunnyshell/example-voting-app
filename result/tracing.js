'use strict';

/**
 * OpenTelemetry bootstrap for the result service.
 *
 * Loaded before any application code via `node --require ./tracing.js server.js`
 * (see Dockerfile / package.json). Loading it first is what allows the auto
 * instrumentation to patch http, express, pg and socket.io before they are used.
 *
 * Configuration comes from the standard OTEL_* environment variables:
 *   OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_RESOURCE_ATTRIBUTES,
 *   OTEL_SDK_DISABLED, OTEL_LOG_LEVEL
 */

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { Resource } = require('@opentelemetry/resources');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');

if (process.env.OTEL_SDK_DISABLED === 'true') {
  console.log('OpenTelemetry SDK disabled via OTEL_SDK_DISABLED');
  return;
}

// Surface SDK problems (e.g. unreachable collector) instead of failing silently.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel[process.env.OTEL_LOG_LEVEL || 'ERROR']);

const resource = new Resource({
  'service.name': process.env.OTEL_SERVICE_NAME || 'result',
  'service.version': process.env.SERVICE_VERSION || 'dev',
  'service.namespace': process.env.SERVICE_NAMESPACE || 'voting-app',
  'deployment.environment': process.env.DEPLOYMENT_ENVIRONMENT || 'local',
});

const sdk = new NodeSDK({
  resource,
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 15000),
  }),
  logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
  instrumentations: [
    getNodeAutoInstrumentations({
      // Noisy and of no value in this app.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-http': {
        // The result page polls over websockets; health probes would swamp Tempo.
        ignoreIncomingRequestHook: (req) => ['/healthz', '/favicon.ico'].includes((req.url || '').split('?')[0]),
      },
      // Injects trace_id/span_id into winston records for log<->trace correlation.
      // Log *sending* is handled explicitly by OpenTelemetryTransportV3 in
      // logger.js, so it is disabled here to avoid emitting each record twice.
      '@opentelemetry/instrumentation-winston': { enabled: true, disableLogSending: true },
    }),
  ],
});

sdk.start();
console.log(
  `OpenTelemetry initialised: endpoint=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '<unset>'} service=${resource.attributes['service.name']}`
);

// Flush buffered telemetry on shutdown so the last spans of a scaled-down
// ephemeral environment are not lost.
const shutdown = () => sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
