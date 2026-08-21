"""OpenTelemetry bootstrap for the vote service.

Everything is configured through the standard OTEL_* environment variables so the
same image behaves correctly in docker-compose, Kubernetes and Bunnyshell without
code changes:

    OTEL_SERVICE_NAME              logical service name (semconv: service.name)
    OTEL_EXPORTER_OTLP_ENDPOINT    collector endpoint, e.g. http://otel-collector:4318
    OTEL_EXPORTER_OTLP_PROTOCOL    http/protobuf (default here) or grpc
    OTEL_RESOURCE_ATTRIBUTES       extra resource attrs, e.g. deployment.environment=stage-1
    OTEL_TRACES_SAMPLER            parentbased_traceidratio (default)
    OTEL_SDK_DISABLED              set to "true" to turn the SDK off entirely

Signals wired up: traces, metrics and logs -- all exported over OTLP to the
collector, which is the only component that knows where Grafana lives.
"""

import logging
import os

from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

# Resource attributes are the primary way Grafana groups telemetry. service.name,
# service.version and deployment.environment come from the environment so a
# Bunnyshell ephemeral env is distinguishable from every other one.
_RESOURCE = Resource.create(
    {
        "service.name": os.getenv("OTEL_SERVICE_NAME", "vote"),
        "service.version": os.getenv("SERVICE_VERSION", "dev"),
        "service.namespace": os.getenv("SERVICE_NAMESPACE", "voting-app"),
        "deployment.environment": os.getenv("DEPLOYMENT_ENVIRONMENT", "local"),
    }
)

_ENABLED = os.getenv("OTEL_SDK_DISABLED", "false").lower() != "true"

# Module level handles so app code can create spans/metrics without re-reading config.
tracer = trace.get_tracer("voting-app.vote")
meter = metrics.get_meter("voting-app.vote")

votes_counter = None
vote_latency = None


def _setup_traces():
    provider = TracerProvider(resource=_RESOURCE)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)


def _setup_metrics():
    reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(),
        export_interval_millis=int(os.getenv("OTEL_METRIC_EXPORT_INTERVAL", "15000")),
    )
    metrics.set_meter_provider(MeterProvider(resource=_RESOURCE, metric_readers=[reader]))


def _setup_logs():
    """Route Python logging through OTLP so logs carry trace_id/span_id."""
    provider = LoggerProvider(resource=_RESOURCE)
    provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
    set_logger_provider(provider)

    handler = LoggingHandler(level=logging.INFO, logger_provider=provider)
    logging.getLogger().addHandler(handler)

    # Also stamp trace ids into stdout lines, so Loki-scraped container logs can be
    # correlated even when the OTLP log pipeline is not the source of truth.
    LoggingInstrumentor().instrument(set_logging_format=False)


def _setup_instruments():
    """Business metrics. Names follow the OTel metric naming guidelines."""
    global votes_counter, vote_latency

    votes_counter = meter.create_counter(
        "votes.submitted",
        unit="{vote}",
        description="Number of votes accepted by the vote service",
    )
    vote_latency = meter.create_histogram(
        "votes.enqueue.duration",
        unit="s",
        description="Time spent pushing a vote onto the Redis queue",
    )


def init(app=None):
    """Initialise the SDK and auto-instrumentation. Safe to call once at startup."""
    if not _ENABLED:
        logging.getLogger(__name__).info("OpenTelemetry SDK disabled via OTEL_SDK_DISABLED")
        return

    _setup_traces()
    _setup_metrics()
    _setup_logs()
    _setup_instruments()

    # Auto-instrumentation: inbound HTTP spans + outbound Redis command spans.
    if app is not None:
        FlaskInstrumentor().instrument_app(
            app,
            # Health probes would otherwise dominate the trace volume in a demo.
            excluded_urls=os.getenv("OTEL_PYTHON_FLASK_EXCLUDED_URLS", "healthz,metrics"),
        )
    RedisInstrumentor().instrument()

    logging.getLogger(__name__).info(
        "OpenTelemetry initialised: endpoint=%s service=%s",
        os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "<unset>"),
        _RESOURCE.attributes.get("service.name"),
    )
