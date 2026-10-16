developing

# Project State

This document is the single source of truth for the project's operational state and contributor permissions. The first line declares the active state: `developing` or `production`. All contributors and coding agents must consult this state before refactoring code, altering database schemas, or performing data operations.

## `developing`

The project is in active pre-production development. Velocity, code cleanliness, and structural elegance take priority over backward compatibility and data preservation.

### Code refactoring

- **Clean cutovers**: Refactor code, signatures, abstractions, and module seams directly.
- **No compatibility shims**: Eliminate obsolete adapters, legacy parameters, and deprecated wrappers rather than preserving them.
- **Contract freedom**: Reshape internal and worker interfaces freely to match the cleanest design.
- **OpenAPI contracts guarded**: Never modify the OpenAPI contract specs (`packages/contracts`) directly. Ask the user before any contract change and proceed only when the change is genuinely required; otherwise leave the contracts unchanged.

### Database schema and migrations

- **Migration-only schema changes**: Apply every schema change by adding a new migration script in `packages/database/migrations/`; never edit, reorder, or consolidate existing migration files.
- **Breaking schema alterations**: Add, rename, modify, or drop tables, columns, indexes, and constraints through new migrations without multi-phase migration wrappers.
- **No dual-write or backward-compatibility layers**: Write queries directly against the new schema; omit fallback columns and legacy query paths.

### Data management and persistence

- **Destructive resets permitted**: Wipe, truncate, recreate, or reseed local and development database instances at will.
- **Ephemeral data model**: Treat all stored entities, queue messages, and media assets as ephemeral test data; no data retention or migration safety is required.

---

## `production`

The project is serving production traffic with live users, tenants, and persistent data. System stability, contract continuity, and zero data loss are mandatory. All destructive shortcuts permitted in `developing` are strictly prohibited.

### Code refactoring

- **Contract continuity**: Maintain strict backward compatibility across all public HTTP endpoints, queue message schemas, webhook payloads, and worker interfaces.
- **Phased cutovers**: Deprecate interfaces before removal; support old and new contract shapes concurrently across deployment windows.
- **Rollback safety**: Keep codebase changes backward-compatible with the immediately preceding deployment so rollbacks do not cause downtime or errors.

### Database schema and migrations

- **Strictly additive migrations**: Follow the expand-and-contract pattern. New columns must be nullable or supply default values.
- **No destructive schema operations**: Never drop or rename active tables, columns, or constraints in a single release.
- **Zero-downtime execution**: Author migrations that run safely while older and newer application workers execute concurrently.

### Data management and persistence

- **Zero data loss**: Preserve all persistent database records, Hyperdrive connections, and stored assets.
- **Destructive operations prohibited**: Never run truncate, drop table, drop database, or bulk wipe operations against persistent environments.
- **Async job and workflow safety**: Preserve in-flight queue jobs, cron triggers, workflows, and durable object state without disruption.
