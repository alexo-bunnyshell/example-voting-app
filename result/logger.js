'use strict';

// Winston is used instead of console.log so every line becomes a structured
// record. Two things happen to each record:
//   1. the OTel winston instrumentation (tracing.js) injects trace_id/span_id,
//      so container logs scraped into Loki can be correlated with Tempo traces;
//   2. OpenTelemetryTransportV3 emits the record over OTLP as a real log signal,
//      carrying the same resource attributes as the traces and metrics.
const winston = require('winston');
const { OpenTelemetryTransportV3 } = require('@opentelemetry/winston-transport');

module.exports = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: {
    'service.name': process.env.OTEL_SERVICE_NAME || 'result',
    'deployment.environment': process.env.DEPLOYMENT_ENVIRONMENT || 'local',
  },
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports:
    process.env.OTEL_SDK_DISABLED === 'true'
      ? [new winston.transports.Console()]
      : [new winston.transports.Console(), new OpenTelemetryTransportV3()],
});
