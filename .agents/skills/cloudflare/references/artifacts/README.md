# Cloudflare Artifacts

Use Artifacts to store versioned file trees — repos, build outputs, checkpoints, generated assets — behind a repo-style interface reachable from Workers, the REST API, and Git-compatible clients. Artifacts is in closed beta; confirm access before implementation. For objects by key, config by key, or relational rows, use [R2](../r2/README.md), [KV](../kv/README.md), or [D1](../d1/README.md) directly.

Prefer retrieval over memory for availability, authentication, route shapes, limits, and pricing: start at the [Artifacts docs](https://developers.cloudflare.com/artifacts/index.md).

## Choose a task

| Task                                                          | Start here                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Configure the Wrangler binding, Worker typing, or REST access | [Configuration](configuration.md)                                      |
| Call binding methods or REST routes for repos and tokens      | [API](api.md)                                                          |
| Set up agent or sandbox workflows                             | [Configuration](configuration.md), then [API](api.md)                  |
| Verify auth, routes, limits, or pricing                       | [Artifacts docs](https://developers.cloudflare.com/artifacts/index.md) |

## Workflow guidance

- Create one repo per agent, session, workspace, or task when work should stay isolated; fork from a stable baseline when many repos need the same starter files.
- Use branches only when collaborators share one repo's lifecycle; use namespaces to separate environments, teams, or high-rate workloads.
- Repo creation returns a git remote URL and an initial repo-scoped token. Import from an existing HTTPS remote through the REST API rather than the Workers binding.

## See also

- [Artifacts docs](https://developers.cloudflare.com/artifacts/index.md)
- [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/index.md) and [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/index.md)
