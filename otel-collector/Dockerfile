# The config is baked into the image rather than mounted, so the collector
# deploys as an ordinary Bunnyshell application component with no volume or
# ConfigMap wiring. Everything environment-specific stays in env vars.
FROM otel/opentelemetry-collector-contrib:0.115.1

COPY config.yaml /etc/otelcol-contrib/config.yaml

# OTLP gRPC / OTLP HTTP / Prometheus scrape / health / zpages
EXPOSE 4317 4318 8889 13133 55679

CMD ["--config=/etc/otelcol-contrib/config.yaml"]
