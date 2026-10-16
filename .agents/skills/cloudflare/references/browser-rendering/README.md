# Browser Run (formerly Browser Rendering)

Use Browser Run for screenshots, PDFs, rendered content extraction, and browser automation. Read the relevant current documentation before implementing; use the [documentation index](https://developers.cloudflare.com/browser-run/llms.txt) to discover additional guides.

Choose the integration by the work and runtime:

- Self-contained screenshot, PDF, or extraction → Quick Actions, available through REST and Workers bindings.
- Multi-step interaction or persistent state → browser sessions: Cloudflare's Puppeteer or Playwright package in Workers, CDP from external scripts or CI.
- Adapting existing automation → preserve its library where supported and check installed versions against the corresponding guide.

## Choose a task

| Task                                             | Reference                         |
| ------------------------------------------------ | --------------------------------- |
| Set up bindings, dependencies, or development    | [Configuration](configuration.md) |
| Select an endpoint or browser client API         | [API](api.md)                     |
| Implement a workflow or manage reusable sessions | [Patterns](patterns.md)           |
| Diagnose failures or plan capacity and cost      | [Gotchas](gotchas.md)             |
