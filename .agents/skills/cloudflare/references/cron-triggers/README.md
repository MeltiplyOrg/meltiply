# Cloudflare Cron Triggers

Use Cron Triggers to start periodic Worker jobs. Fetch the relevant current documentation before implementing; configuration, API signatures, and limits belong in the docs.

## Choose a task

| Task                                            | Start here                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schedule, deploy, or remove a recurring job     | [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/index.md) and [Configuration](configuration.md)                                  |
| Implement the scheduled handler                 | [Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/index.md) and [API](api.md)                                              |
| Choose execution boundaries or integrations     | [Patterns](patterns.md)                                                                                                                                                |
| Schedule durable multi-step work                | [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/index.md) — check before adding a Worker whose only job is starting a Workflow |
| Diagnose timing, failures, or repeated work     | [Gotchas](gotchas.md)                                                                                                                                                  |
| Check capacity for the plan and invocation type | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/index.md)                                                                                   |

## See also

- [Workflows](../workflows/README.md) — durable multi-step jobs
- [Queues](../queues/README.md) — asynchronous message processing
