# Cloudflare Tail Workers

Use Tail Workers when execution events need custom processing — filtering, transformation, or delivery to a destination Cloudflare does not export to. Before adding one, check whether built-in [OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/index.md) already meets the destination's needs; only the filtering or transformation that remains justifies a custom consumer. Fetch current documentation before implementing handlers, configuration, or integrations.

| Task                                       | Documentation                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Decide whether custom processing is needed | [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/index.md)     |
| Inspect a deployment interactively         | [Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/index.md) |
| Implement the consumer                     | [Tail handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/index.md)          |

## In This Reference

- [configuration.md](./configuration.md) — producer, consumer, destination, and environment setup
- [api.md](./api.md) — event fields, execution outcomes, and redaction
- [patterns.md](./patterns.md) — destination and filtering decisions
- [gotchas.md](./gotchas.md) — connection, data, and delivery investigation

See [observability](../observability/README.md) for broader logging and tracing choices.
