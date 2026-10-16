# Miniflare

Miniflare provides programmatic control of the local Workers simulator. Reach for it when the higher-level testing tools do not expose the control needed; for interactive local development, use the project's Wrangler or Vite workflow. Read the linked documentation before choosing APIs, configuration, or a migration path.

## Choose the testing tool

| Need                                             | Start here                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Unit tests that execute in the Workers runtime   | [Workers Vitest setup](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/index.md) |
| Integration tests against built Workers          | [Integration test harness](https://developers.cloudflare.com/workers/testing/test-harness/index.md)                         |
| Low-level simulator control for a custom harness | [Miniflare testing guide](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/index.md)               |
| Binding access from a Node.js process            | [Wrangler getPlatformProxy](https://developers.cloudflare.com/workers/wrangler/api/index.md#getplatformproxy)               |

## Read for the task

- [Get started](https://developers.cloudflare.com/workers/testing/miniflare/get-started/index.md) — installation, scripts, lifecycle, and event dispatch.
- [Configuration](./configuration.md) — modules, bindings, compatibility, and multiple Workers.
- [API routing](./api.md) — events and access to local resources.
- [Testing patterns](./patterns.md) — runtime choice, mocking, and test lifecycle.
- [Troubleshooting and migrations](./gotchas.md) — build/configuration differences and existing test suites.
