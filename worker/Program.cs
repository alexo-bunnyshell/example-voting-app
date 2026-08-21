using System;
using System.Collections.Generic;
using System.Data.Common;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;
using Npgsql;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;
using StackExchange.Redis;

namespace Worker
{
    public class Program
    {
        // The vote service injects W3C trace context into the queued JSON payload.
        // Using the globally configured propagator keeps both ends in sync if the
        // propagation format is ever changed via OTEL_PROPAGATORS.
        //
        // Resolved on each use rather than cached in a static field: the SDK installs
        // the real composite propagator while building the TracerProvider, and a field
        // initialiser would capture the no-op propagator that precedes it -- which
        // silently breaks propagation and makes every vote a separate root trace.
        private static TextMapPropagator Propagator => Propagators.DefaultTextMapPropagator;

        private static ILogger _log;

        public static int Main(string[] args)
        {
            var redisHost = Environment.GetEnvironmentVariable("REDIS_HOST") ?? "redis";
            var pgConnectionString = Environment.GetEnvironmentVariable("DATABASE_CONNECTION")
                ?? "Server=db;Username=postgres;Password=postgres;";

            IConnectionMultiplexer redisConn = null;
            try
            {
                // Redis is connected first so the multiplexer can be handed to the
                // OpenTelemetry Redis instrumentation during initialisation.
                redisConn = OpenRedisConnection(redisHost);
                _log = Telemetry.Init(redisConn);

                var pgsql = OpenDbConnection(pgConnectionString);
                var redis = redisConn.GetDatabase();

                // Keep alive is not implemented in Npgsql yet. This workaround was recommended:
                // https://github.com/npgsql/npgsql/issues/1214#issuecomment-235828359
                var keepAliveCommand = pgsql.CreateCommand();
                keepAliveCommand.CommandText = "SELECT 1";

                // Queue depth is state rather than an event, so it is observed once per
                // export interval instead of being incremented from the hot loop.
                Telemetry.Meter.CreateObservableGauge(
                    "votes.queue.depth",
                    () =>
                    {
                        try { return redis.ListLength("votes"); }
                        catch { return 0L; }
                    },
                    "{vote}",
                    "Votes waiting in the Redis queue");

                var definition = new { vote = "", voter_id = "", traceparent = "", tracestate = "" };
                while (true)
                {
                    // Slow down to prevent CPU spike, only query each 100ms
                    Thread.Sleep(100);

                    // Reconnect redis if down
                    if (redisConn == null || !redisConn.IsConnected)
                    {
                        _log.LogWarning("Reconnecting Redis");
                        redisConn = OpenRedisConnection(redisHost);
                        redis = redisConn.GetDatabase();
                    }

                    string json = redis.ListLeftPopAsync("votes").Result;
                    if (json == null)
                    {
                        keepAliveCommand.ExecuteNonQuery();
                        continue;
                    }

                    var vote = JsonConvert.DeserializeAnonymousType(json, definition);
                    pgsql = ProcessVote(pgsql, pgConnectionString, vote.voter_id, vote.vote, json);
                }
            }
            catch (Exception ex)
            {
                if (_log != null)
                {
                    _log.LogError(ex, "Worker terminated unexpectedly");
                }
                else
                {
                    Console.Error.WriteLine(ex.ToString());
                }
                return 1;
            }
            finally
            {
                Telemetry.Shutdown();
            }
        }

        /// <summary>
        /// Handles one vote inside a CONSUMER span that continues the trace started by
        /// the vote service, which is what makes vote -> redis -> worker -> postgres
        /// render as a single distributed trace in Tempo.
        /// </summary>
        private static NpgsqlConnection ProcessVote(
            NpgsqlConnection pgsql, string connectionString, string voterId, string vote, string rawPayload)
        {
            var parentContext = Propagator.Extract(
                default, rawPayload, ExtractTraceContext);
            Baggage.Current = parentContext.Baggage;

            using (var activity = Telemetry.Source.StartActivity(
                       "votes process", ActivityKind.Consumer, parentContext.ActivityContext))
            {
                var started = Stopwatch.StartNew();
                activity?.SetTag("app.vote.option", vote);
                activity?.SetTag("app.voter.id", voterId);
                activity?.SetTag("messaging.system", "redis");
                activity?.SetTag("messaging.destination.name", "votes");
                activity?.SetTag("messaging.operation", "process");

                try
                {
                    // Reconnect DB if down
                    if (!pgsql.State.Equals(System.Data.ConnectionState.Open))
                    {
                        _log.LogWarning("Reconnecting DB");
                        pgsql = OpenDbConnection(connectionString);
                    }

                    UpdateVote(pgsql, voterId, vote);

                    Telemetry.VotesProcessed.Add(1, new KeyValuePair<string, object>("vote.option", vote));
                    _log.LogInformation("Processing vote for '{Option}' by '{VoterId}'", vote, voterId);
                }
                catch (Exception ex)
                {
                    Telemetry.VotesFailed.Add(1, new KeyValuePair<string, object>("vote.option", vote));
                    activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
                    activity?.AddTag("exception.type", ex.GetType().FullName);
                    _log.LogError(ex, "Failed to persist vote for '{Option}'", vote);
                }
                finally
                {
                    Telemetry.ProcessingDuration.Record(
                        started.Elapsed.TotalSeconds,
                        new KeyValuePair<string, object>("vote.option", vote));
                }
            }

            return pgsql;
        }

        /// <summary>Reads a single propagation header out of the queued JSON payload.</summary>
        private static IEnumerable<string> ExtractTraceContext(string payload, string key)
        {
            try
            {
                var fields = JsonConvert.DeserializeObject<Dictionary<string, string>>(payload);
                if (fields != null && fields.TryGetValue(key, out var value) && !string.IsNullOrEmpty(value))
                {
                    return new[] { value };
                }
            }
            catch (JsonException)
            {
                // A malformed payload simply starts a new trace.
            }

            return Enumerable.Empty<string>();
        }

        private static NpgsqlConnection OpenDbConnection(string connectionString)
        {
            NpgsqlConnection connection;

            while (true)
            {
                try
                {
                    connection = new NpgsqlConnection(connectionString);
                    connection.Open();
                    break;
                }
                catch (SocketException)
                {
                    Log(LogLevel.Warning, "Waiting for db");
                    Thread.Sleep(1000);
                }
                catch (DbException)
                {
                    Log(LogLevel.Warning, "Waiting for db");
                    Thread.Sleep(1000);
                }
            }

            Log(LogLevel.Information, "Connected to db");

            var command = connection.CreateCommand();
            command.CommandText = @"CREATE TABLE IF NOT EXISTS votes (
                                        id VARCHAR(255) NOT NULL UNIQUE,
                                        vote VARCHAR(255) NOT NULL
                                    )";
            command.ExecuteNonQuery();

            return connection;
        }

        private static ConnectionMultiplexer OpenRedisConnection(string hostname)
        {
            // Use IP address to workaround https://github.com/StackExchange/StackExchange.Redis/issues/410
            var ipAddress = GetIp(hostname);
            Log(LogLevel.Information, $"Found redis at {ipAddress}");

            while (true)
            {
                try
                {
                    Log(LogLevel.Information, "Connecting to redis");
                    return ConnectionMultiplexer.Connect(ipAddress);
                }
                catch (RedisConnectionException)
                {
                    Log(LogLevel.Warning, "Waiting for redis");
                    Thread.Sleep(1000);
                }
            }
        }

        private static string GetIp(string hostname)
            => Dns.GetHostEntryAsync(hostname)
                .Result
                .AddressList
                .First(a => a.AddressFamily == AddressFamily.InterNetwork)
                .ToString();

        private static void UpdateVote(NpgsqlConnection connection, string voterId, string vote)
        {
            var command = connection.CreateCommand();
            try
            {
                command.CommandText = "INSERT INTO votes (id, vote) VALUES (@id, @vote)";
                command.Parameters.AddWithValue("@id", voterId);
                command.Parameters.AddWithValue("@vote", vote);
                command.ExecuteNonQuery();
            }
            catch (DbException)
            {
                command.CommandText = "UPDATE votes SET vote = @vote WHERE id = @id";
                command.ExecuteNonQuery();
            }
            finally
            {
                command.Dispose();
            }
        }

        /// <summary>Startup happens before the logger exists, so fall back to the console.</summary>
        private static void Log(LogLevel level, string message)
        {
            if (_log != null)
            {
                _log.Log(level, message);
            }
            else
            {
                Console.Error.WriteLine(message);
            }
        }
    }
}
