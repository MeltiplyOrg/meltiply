# Cloudflare Containers

Use [Containers](https://developers.cloudflare.com/containers/index.md) for workloads that need a container image, custom runtime, system dependencies, full filesystem access, or CPU/memory beyond the [Workers runtime](https://developers.cloudflare.com/workers/index.md).

Containers are controlled through [Durable Objects](https://developers.cloudflare.com/durable-objects/index.md). An instance's identity does not make its filesystem persistent: design for restarts and store durable data outside the container disk. Read [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/index.md) and [Container interface](https://developers.cloudflare.com/containers/api/container-class/index.md) for the relationship between the process, its Durable Object, and persistent storage.

## Choose a task

Read the linked page before writing code or configuration; use its current API and constraints rather than reconstructing them from memory.

| Task                                                       | Start here                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Create a project and deploy the first container            | [Get started](https://developers.cloudflare.com/containers/get-started/index.md) |
| Configure images, bindings, instance sizes, or deployments | [Configuration](configuration.md)                                                |
| Control startup, requests, lifecycle, or scheduling        | [API](api.md)                                                                    |
| Choose routing or connect other services                   | [Patterns](patterns.md)                                                          |
| Diagnose startup, persistence, capacity, or rollout issues | [Gotchas](gotchas.md)                                                            |

For additional topics, consult the [Containers documentation index](https://developers.cloudflare.com/containers/llms.txt).
