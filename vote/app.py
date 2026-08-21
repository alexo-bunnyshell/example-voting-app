from flask import Flask, render_template, request, make_response, g, jsonify
from redis import Redis
import os
import socket
import random
import json
import logging
import time

import telemetry
from opentelemetry import trace
from opentelemetry.propagate import inject
from opentelemetry.trace import SpanKind, Status, StatusCode

option_a = os.getenv('OPTION_A', "AI Lion")
option_b = os.getenv('OPTION_B', "Dinos")

hostname = socket.gethostname()

app = Flask(__name__)

gunicorn_error_logger = logging.getLogger('gunicorn.error')
app.logger.handlers.extend(gunicorn_error_logger.handlers)
app.logger.setLevel(logging.INFO)

# Must run before the first request so Flask/Redis auto-instrumentation is in place.
telemetry.init(app)

def get_redis():
    if not hasattr(g, 'redis'):
        g.redis = Redis(host=os.getenv("REDIS_HOST", "redis"), db=0, socket_timeout=5)
    return g.redis


@app.route("/", methods=['POST','GET'])
def hello():
    voter_id = request.cookies.get('voter_id')
    if not voter_id:
        voter_id = hex(random.getrandbits(64))[2:-1]

    vote = None

    # Attributes on the auto-created Flask server span, so every request in Tempo
    # can be filtered by voter without needing a child span.
    current = trace.get_current_span()
    current.set_attribute("app.voter.id", voter_id)

    if request.method == 'POST':
        vote = request.form['vote']
        _submit_vote(voter_id, vote)

    resp = make_response(render_template(
        'index.html',
        option_a=option_a,
        option_b=option_b,
        hostname=hostname,
        vote=vote,
    ))
    resp.set_cookie('voter_id', voter_id)
    return resp


def _submit_vote(voter_id, vote):
    """Enqueue a vote and hand the trace context to the worker via the payload."""
    with telemetry.tracer.start_as_current_span(
        "vote.enqueue",
        kind=SpanKind.PRODUCER,
        attributes={
            "app.vote.option": vote,
            "app.voter.id": voter_id,
            "messaging.system": "redis",
            "messaging.destination.name": "votes",
            "messaging.operation": "publish",
        },
    ) as span:
        started = time.monotonic()

        # W3C trace context travels inside the queued message, which is what makes
        # vote -> redis -> worker -> postgres show up as one distributed trace.
        payload = {'voter_id': voter_id, 'vote': vote}
        inject(payload)

        try:
            redis = get_redis()
            redis.rpush('votes', json.dumps(payload))
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            app.logger.exception('Failed to enqueue vote for %s', vote)
            raise

        elapsed = time.monotonic() - started
        if telemetry.votes_counter is not None:
            telemetry.votes_counter.add(1, {"vote.option": vote})
            telemetry.vote_latency.record(elapsed, {"vote.option": vote})

        # Emitted through the OTLP log pipeline with trace_id/span_id attached.
        app.logger.info('Received vote for %s', vote)


@app.route("/healthz")
def healthz():
    return jsonify(status="ok", hostname=hostname)


if __name__ == "__main__":
    app.run(host='0.0.0.0', port=80, debug=True, threaded=True)
