var express = require('express'),
    async = require('async'),
    path = require('path'),
    { Pool } = require('pg'),
    cookieParser = require('cookie-parser'),
    app = express(),
    server = require('http').Server(app),
    io = require('socket.io')(server);

var { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
var logger = require('./logger');

var tracer = trace.getTracer('voting-app.result');
var meter = metrics.getMeter('voting-app.result');

// Business metrics. The tally is an observable gauge because it is state, not a
// stream of events -- the SDK reads it once per export interval.
var currentVotes = { a: 0, b: 0 };
meter
  .createObservableGauge('votes.total', {
    unit: '{vote}',
    description: 'Current vote tally as stored in Postgres',
  })
  .addCallback(function (observer) {
    observer.observe(currentVotes.a, { 'vote.option': 'a' });
    observer.observe(currentVotes.b, { 'vote.option': 'b' });
  });

var pollCounter = meter.createCounter('votes.poll.count', {
  description: 'Number of tally queries issued against Postgres',
});
var pollErrors = meter.createCounter('votes.poll.errors', {
  description: 'Number of failed tally queries',
});
var connectedClients = meter.createUpDownCounter('result.websocket.clients', {
  description: 'Currently connected result-page websocket clients',
});

var port = process.env.PORT || 4000;

io.on('connection', function (socket) {
  connectedClients.add(1);
  logger.info('client connected', { 'socket.id': socket.id });

  socket.emit('message', { text : 'Welcome!' });

  socket.on('subscribe', function (data) {
    socket.join(data.channel);
  });

  socket.on('disconnect', function () {
    connectedClients.add(-1);
  });
});

var pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@db/postgres'
});

async.retry(
  {times: 1000, interval: 1000},
  function(callback) {
    pool.connect(function(err, client, done) {
      if (err) {
        logger.warn('Waiting for db');
      }
      callback(err, client);
    });
  },
  function(err, client) {
    if (err) {
      return logger.error('Giving up connecting to db', { error: String(err) });
    }
    logger.info('Connected to db');
    getVotes(client);
  }
);

function getVotes(client) {
  // The poll loop has no inbound request to hang off, so it gets its own root
  // span. pg auto-instrumentation nests the actual SQL span underneath.
  tracer.startActiveSpan('votes.poll', function (span) {
    client.query('SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote', [], function(err, result) {
      pollCounter.add(1);

      if (err) {
        pollErrors.add(1);
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        logger.error('Error performing query', { error: String(err) });
      } else {
        var votes = collectVotesFromResult(result);
        currentVotes = votes;
        span.setAttribute('app.votes.a', votes.a);
        span.setAttribute('app.votes.b', votes.b);
        io.sockets.emit("scores", JSON.stringify(votes));
      }

      span.end();
      setTimeout(function() {getVotes(client) }, Number(process.env.POLL_INTERVAL_MS || 1000));
    });
  });
}

function collectVotesFromResult(result) {
  var votes = {a: 0, b: 0};

  result.rows.forEach(function (row) {
    votes[row.vote] = parseInt(row.count);
  });

  return votes;
}

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname + '/views'));

app.get('/', function (req, res) {
  res.sendFile(path.resolve(__dirname + '/views/index.html'));
});

app.get('/healthz', function (req, res) {
  res.json({ status: 'ok', votes: currentVotes });
});

server.listen(port, function () {
  var port = server.address().port;
  logger.info('App running', { port: port });
});
