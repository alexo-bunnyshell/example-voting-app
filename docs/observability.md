# OpenTelemetry instrumentation

The voting app is instrumented for all three OpenTelemetry signals — **traces,
metrics and logs** — across all three services, and ships them to a Grafana
(Tempo / Mimir / Loki) backend through a collector gateway.

```
  vote (Python/Flask) ─┐
  result (Node/Express)├─ OTLP/HTTP ─▶ otel-collector ─ OTLP/HTTP ─▶ Grafana LGTM
  worker (.NET) ───────┘                    │
                                            ├─▶ debug exporter (stdout)
                                            └─▶ :8889/metrics (Prometheus scrape)
```

## Why a collector instead of direct export

* The backend endpoint and its credentials live in **one** place. Application
  images carry no vendor configuration and no secrets.
* Batching, retry and queueing happen out of process, so a slow or unreachable
  backend never adds latency to a vote.
* Environment-scoped resource attributes (`deployment.environment`,
  `bunnyshell.environment.id`, `k8s.namespace.name`) are stamped once, in the
  collector, rather than in three different languages.
* Repointing the backend is an environment-variable change and a restart — no
  rebuild of any application image.

## Pointing it at your Grafana

Set these on the environment (Bunnyshell env vars, or a `.env` for compose):

| Variable | Meaning |
| --- | --- |
| `OTLP_BACKEND_ENDPOINT` | OTLP/HTTP base URL, e.g. `https://otlp-gateway-prod-eu-west-2.grafana.net/otlp` or in-cluster `http://alloy.monitoring.svc:4318` |
| `OTLP_BACKEND_AUTH_HEADER` | Full `Authorization` header value, e.g. `Basic <base64 of instanceID:token>` |
| `OTLP_BACKEND_INSECURE_SKIP_VERIFY` | `true` to accept a self-signed backend certificate |
| `OTEL_DEBUG_VERBOSITY` | `basic` \| `normal` \| `detailed` for the stdout exporter |

Until `OTLP_BACKEND_ENDPOINT` is set, it defaults to a hostname that does not
resolve. The collector logs a DNS failure per retry cycle and drops the batch;
the debug and Prometheus exporters keep working, so the pipeline is still fully
demonstrable. Nothing else in the environment is affected.

## What is instrumented

### vote — Python / Flask (`vote/telemetry.py`)

* Auto-instrumentation for **Flask** (inbound HTTP server spans) and **Redis**
  (outbound command spans). Health and metrics URLs are excluded so probes do
  not dominate trace volume.
* A manual `vote.enqueue` PRODUCER span carrying `app.vote.option` and
  `app.voter.id`, with errors recorded on the span.
* Metrics: `votes.submitted` (counter, by option) and `votes.enqueue.duration`
  (histogram).
* Logs go through the OTLP log pipeline with `trace_id`/`span_id` attached.

### result — Node / Express (`result/tracing.js`, `result/logger.js`)

* `@opentelemetry/auto-instrumentations-node` covers **http**, **express**,
  **pg** and **socket.io**. `fs`, `dns` and `net` are disabled as noise.
* A `votes.poll` root span per tally query, with the SQL span nested underneath
  by the pg instrumentation.
* Metrics: `votes.total` (observable gauge, by option), `votes.poll.count`,
  `votes.poll.errors`, `result.websocket.clients` (up/down counter).
* Winston logs are emitted as real OTLP log records via
  `OpenTelemetryTransportV3`, and the winston instrumentation injects
  `trace_id`/`span_id` into the stdout JSON so Loki-scraped container logs
  correlate too.

### worker — .NET (`worker/Telemetry.cs`)

* Instrumentation for **Npgsql** and **StackExchange.Redis**, plus .NET
  **runtime** metrics (GC, thread pool, allocations).
* A `votes process` CONSUMER span per vote.
* Metrics: `votes.processed`, `votes.failed`, `votes.processing.duration`
  (histogram) and `votes.queue.depth` (observable gauge reading Redis `LLEN`).
* `ILogger` records exported over OTLP with formatted messages and scopes.

## End-to-end trace across the Redis queue

The demo-worthy part. A vote is not an HTTP call from `vote` to `worker` — it
goes through a Redis list, so ordinary HTTP context propagation does not apply.

`vote` injects W3C trace context **into the queued message body**:

```python
payload = {'voter_id': voter_id, 'vote': vote}
inject(payload)          # adds "traceparent" (and "tracestate" if present)
redis.rpush('votes', json.dumps(payload))
```

`worker` extracts it from the same payload and starts its span as a child:

```csharp
var parentContext = Propagator.Extract(default, rawPayload, ExtractTraceContext);
using var activity = Telemetry.Source.StartActivity(
    "votes process", ActivityKind.Consumer, parentContext.ActivityContext);
```

The result in Tempo is a single trace:

```
POST / (vote, SERVER)
└── vote.enqueue (PRODUCER)
    └── RPUSH votes (Redis client span)
        └── votes process (worker, CONSUMER)
            └── INSERT INTO votes (Npgsql span)
```

### Gotcha worth knowing

The .NET propagator must be resolved **at use time**, not cached in a static
field. The SDK installs the real composite propagator while building the
`TracerProvider`; a field initialiser that runs before that captures the no-op
propagator instead, and every vote silently becomes its own root trace with no
error anywhere.

## Dropping poll-loop noise

The worker polls Redis every 100ms and issues a Postgres `SELECT 1` keepalive on
every empty poll — roughly 20 root spans per second of infrastructure chatter
that would bury the traces describing an actual vote. A `filter` processor in the
collector drops those root spans, so the applications stay unmodified and the
trace store stays readable.

## Span metrics and the service graph

The collector's `spanmetrics` connector derives RED metrics (rate, errors,
duration) from the spans already flowing through it, so Grafana's service graph
and latency panels work without any additional application code.

## Turning it off

Set `OTEL_SDK_DISABLED=true` on a component. All three services check it and
skip SDK setup entirely, falling back to plain console logging.

## Running locally

```bash
docker compose up -d --build
# optional: ship onwards as well as to stdout
OTLP_BACKEND_ENDPOINT=https://your-grafana/otlp \
OTLP_BACKEND_AUTH_HEADER="Basic <base64>" docker compose up -d otel-collector

open http://localhost:5000   # vote
open http://localhost:5001   # result
open http://localhost:55679/debug/tracez   # collector zpages

docker compose logs -f otel-collector      # every signal, via the debug exporter
curl -s localhost:8889/metrics | grep votes_   # Prometheus view
```
