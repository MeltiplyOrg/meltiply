# Meltiply contracts

[openapi.yaml](openapi.yaml) defines the `/api/v1` API. This package generates
TypeScript types and an `openapi-fetch` client for frontend and Worker consumers.

## Change a contract

Run from the repository root:

```bash
bun run contract:generate
bun run contract:diff --base <git-ref-or-file>
bun run contract:check
```

Edit the specification, then regenerate rather than hand-editing generated types.
The full contract gate bundles the specification and checks examples, compatibility
guard behavior, readiness, and package types. Individual commands live in the root
[package.json](../../package.json).

Review breaking changes against [CHANGELOG.md](CHANGELOG.md)'s versioning and
deprecation process; the diff guard rejects incompatible changes that do not meet
that policy.

## Endpoint readiness

[operation-readiness.json](operation-readiness.json) is the authoritative catalog;
[endpoint-readiness.md](endpoint-readiness.md) is its generated view. After changing
the catalog or operation IDs:

```bash
bun run contract:readiness:generate
bun run contract:readiness:check
```

The check requires exact OpenAPI operation coverage. Promoted states require
immutable evidence: bounded JSON with `schemaVersion: 1`, the expected `kind`,
`result: "passed"`, and the promoted operation in `operationIds`. HTTPS evidence
must match its cataloged SHA-256 digest and is fetched without redirects.

For private evidence, provide the complete authorization-header value through
`MELTIPLY_READINESS_EVIDENCE_AUTHORIZATION` and its exact HTTPS origin through
`MELTIPLY_READINESS_EVIDENCE_AUTH_ORIGIN`. Credentials are sent only to that origin.
`specified` metadata requires neither network evidence nor those credentials.
