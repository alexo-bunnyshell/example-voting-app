using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using Microsoft.Extensions.Logging;
using Npgsql;
using OpenTelemetry;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using StackExchange.Redis;

namespace Worker
{
    /// <summary>
    /// OpenTelemetry bootstrap for the worker.
    ///
    /// Configuration is read from the standard OTEL_* environment variables
    /// (OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL,
    /// OTEL_RESOURCE_ATTRIBUTES), so the same binary works unchanged in
    /// docker-compose and in a Bunnyshell ephemeral environment.
    /// </summary>
    public static class Telemetry
    {
        public const string ActivitySourceName = "voting-app.worker";

        public static readonly ActivitySource Source = new ActivitySource(ActivitySourceName);
        public static readonly Meter Meter = new Meter(ActivitySourceName);

        /// <summary>Votes successfully written to Postgres, tagged by option.</summary>
        public static readonly Counter<long> VotesProcessed =
            Meter.CreateCounter<long>("votes.processed", "{vote}", "Votes persisted by the worker");

        /// <summary>Votes that could not be persisted.</summary>
        public static readonly Counter<long> VotesFailed =
            Meter.CreateCounter<long>("votes.failed", "{vote}", "Votes the worker failed to persist");

        /// <summary>End-to-end handling time for a single vote.</summary>
        public static readonly Histogram<double> ProcessingDuration =
            Meter.CreateHistogram<double>("votes.processing.duration", "s", "Time to persist one vote");

        private static TracerProvider _tracerProvider;
        private static MeterProvider _meterProvider;
        private static ILoggerFactory _loggerFactory;

        public static bool Enabled =>
            !string.Equals(Environment.GetEnvironmentVariable("OTEL_SDK_DISABLED"), "true",
                StringComparison.OrdinalIgnoreCase);

        private static ResourceBuilder BuildResource()
        {
            return ResourceBuilder.CreateDefault()
                .AddService(
                    serviceName: Environment.GetEnvironmentVariable("OTEL_SERVICE_NAME") ?? "worker",
                    serviceNamespace: Environment.GetEnvironmentVariable("SERVICE_NAMESPACE") ?? "voting-app",
                    serviceVersion: Environment.GetEnvironmentVariable("SERVICE_VERSION") ?? "dev")
                .AddAttributes(new[]
                {
                    new KeyValuePair<string, object>(
                        "deployment.environment",
                        Environment.GetEnvironmentVariable("DEPLOYMENT_ENVIRONMENT") ?? "local"),
                })
                .AddEnvironmentVariableDetector();
        }

        /// <summary>
        /// Builds the trace, metric and log pipelines. The Redis multiplexer is passed
        /// in so outbound Redis commands are instrumented; queue depth polling and vote
        /// pops then show up as child spans.
        /// </summary>
        public static ILogger Init(IConnectionMultiplexer redis)
        {
            if (!Enabled)
            {
                _loggerFactory = LoggerFactory.Create(b => b.AddSimpleConsole(o => o.TimestampFormat = "HH:mm:ss "));
                return _loggerFactory.CreateLogger("worker");
            }

            _tracerProvider = Sdk.CreateTracerProviderBuilder()
                .SetResourceBuilder(BuildResource())
                .AddSource(ActivitySourceName)
                .AddNpgsql()
                .AddRedisInstrumentation(redis, options =>
                {
                    // The worker polls Redis every 100ms; recording every no-op pop
                    // would bury the interesting spans.
                    options.SetVerboseDatabaseStatements = false;
                    options.FlushInterval = TimeSpan.FromSeconds(5);
                })
                .AddOtlpExporter()
                .Build();

            _meterProvider = Sdk.CreateMeterProviderBuilder()
                .SetResourceBuilder(BuildResource())
                .AddMeter(ActivitySourceName)
                .AddRuntimeInstrumentation()
                .AddOtlpExporter()
                .Build();

            _loggerFactory = LoggerFactory.Create(builder =>
            {
                builder.AddSimpleConsole(o => o.TimestampFormat = "HH:mm:ss ");
                builder.AddOpenTelemetry(options =>
                {
                    options.SetResourceBuilder(BuildResource());
                    // Trace ids on log records are what makes logs clickable from a
                    // trace in Grafana, and the formatted message keeps them readable.
                    options.IncludeScopes = true;
                    options.IncludeFormattedMessage = true;
                    options.ParseStateValues = true;
                    options.AddOtlpExporter();
                });
            });

            var logger = _loggerFactory.CreateLogger("worker");
            logger.LogInformation(
                "OpenTelemetry initialised: endpoint={Endpoint} service={Service}",
                Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT") ?? "<unset>",
                Environment.GetEnvironmentVariable("OTEL_SERVICE_NAME") ?? "worker");
            return logger;
        }

        /// <summary>Flush pending telemetry before the process exits.</summary>
        public static void Shutdown()
        {
            _tracerProvider?.ForceFlush(5000);
            _meterProvider?.ForceFlush(5000);
            _tracerProvider?.Dispose();
            _meterProvider?.Dispose();
            _loggerFactory?.Dispose();
        }
    }
}
