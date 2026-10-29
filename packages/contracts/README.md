# Meltiply contracts

[openapi.yaml](openapi.yaml) defines the `/api/v1` API. This private workspace
package generates TypeScript types and an `openapi-fetch` client. The public
distribution surface is a GitHub Release tagged `contract-v<SemVer>`, not an npm
package or a copied repository snapshot.

## Pin and upgrade

Download an exact version from [contract releases](https://github.com/MeltiplyOrg/meltiply/releases):

```bash
version=1.0.0
gh release download "contract-v$version" --repo MeltiplyOrg/meltiply \
  --pattern openapi.json --pattern openapi.yaml --pattern changelog.json --pattern SHA256SUMS
sha256sum --check SHA256SUMS
```

The example identifies the first prepared version; a prepared version is not
available until its protected tag has been published. Each release contains only
bundled JSON, bundled YAML, machine-readable `changelog.json`, and SHA-256
checksums. Both OpenAPI documents resolve to the checked-in source, with
`info.version` equal to the tag's version. The workflow never replaces an existing
release or uploads workspace source, credentials, readiness evidence, or deployment
configuration.

Pin the tag and checksum in the consumer repository. To upgrade, bump that pin,
verify checksums, regenerate from JSON or YAML, then resolve compiler and drift-gate
failures. Read `changelog.json` (`version`, `previousVersion`, `changeType`, `changes`,
`contractSha256`) for compatibility impact. A patch corrects a contract without an
intentional compatibility break; a minor adds compatible capabilities; a major
records intentional breaks. The first public release is `1.0.0`.

Before login or any authenticated mutation, request unauthenticated
`GET /api/v1/health`. Compare `contract_version`, **not** application `version`,
using a SemVer library. A conservative consumer requires the same stable major and
a server version at least as new as its pinned contract; prereleases require an
exact match. Otherwise stop with an actionable message naming client/server
contract versions and whether the installation or client must be upgraded. The
server reports its contract; it does not reject older clients. Version agreement
does not promote planning-only operations: check their readiness as well.

Deployment smoke preserves the first-version transition only for the verified
previous SHA during partial rollouts: a missing contract version becomes explicit
`contract_version: null` in evidence, alongside the control-plane-verified previous
Worker ID and Git SHA. Manifest validation binds those identities to the previous
rollout version. Candidate, bootstrap, and 100% rollout smoke remain strict; this
transition does not make contract metadata optional in the public health schema.

## Change a contract

Run from the repository root:

```bash
bun run contract:generate
bun run contract:diff --base <git-ref-or-file>
bun run contract:check
```

Edit the specification, then regenerate rather than hand-editing generated types.
Generation also derives the runtime `CONTRACT_VERSION` from `info.version`.
`contract:check` remains authoritative: lint, both bundles, generation, examples,
real compatibility CLI regressions, comparison against the CI base, readiness and
types. The existing Cloudflare fast lane invokes it; changing an unrelated file
does not exempt a PR that changes the contract. PRs use the merge base of their
base/head commits. Default-branch pushes use the newest reachable contract release
tag; release-tag pushes compare against the preceding release, excluding themselves.
Local runs, feature-branch pushes and initial releases without an applicable
baseline print an explicit skip, never an implicit compatibility pass.

An incompatible diff prints the operation/field diagnostics and an exact
`contract-change:<sha256>` review token. Add a **new** `**Breaking:**` bullet in
Unreleased describing the affected operations/fields, migration, and deprecation
window, including `[contract-change:<sha256>]`. The token binds the entire semantic
base/target pair, excluding only `info.version`; historical entries or tokens for
a different change do not authorize it. Re-run the comparison after any contract
edit. The prepared release's versioned changelog section is also eligible, so
version preparation does not discard the review. Reviewers must still judge the
migration and window; the token proves scope and freshness, not human approval.

For a removal, first publish its deprecation and announce the earliest removal
version/date in the changelog. Record the honored window and replacement in the
breaking release; never silently remove a published operation. During the current
pre-production clean-cutover state, an intentional immediate break must explicitly
say that the window is immediate and explain the client migration. This does not
promise backward compatibility that [STATE.md](../../STATE.md) does not provide.

## Prepare and publish

Never choose or hand-bump a release version. After recording changes, run:

```bash
bun run contract:release:prepare
bun run contract:check
bun run contract:release:artifacts
bun run contract:release:verify
```

If a previous release exists, also run `bun run contract:diff --base
contract-v<previousVersion>` before tagging. Its full-release diff may combine
several merged PRs: record a fresh exact-change review token for that complete span
in the prepared version's changelog section. A release-tag check repeats this
comparison even if each individual PR was compatible with its own merge base.

Preparation compares with the last reachable `contract-v*` release and leaves
unchanged published content at its existing version. Otherwise it derives the next
version, updates `info.version` and catalog version, creates source-bound
[release.json](release.json), moves Unreleased notes
to the versioned changelog, and regenerates types, the runtime version and readiness
view. `**Breaking:**` notes select major, exclusively `**Patch:**` notes select
patch, and other changes select minor. Commit those generated source changes in the
contract PR. A stale source-bound manifest, wrong tag/version or reuse of a released
version fails rather than publishing a changed artifact under an old version.
Re-running preparation refreshes an untagged release's source-bound metadata
without losing its notes or creating duplicate version sections.

[Contract release](../../.github/workflows/contract-release.yml) automatically runs
the same preparation and artifact/runtime smoke on contract branch pushes. It
uploads `contract-release-preparation` containing a patch to apply and commit when
preparing remotely; it never pushes a bot commit or uses a publishing credential
on those refs. Its `contract-release-artifacts` output is a preview, not a GitHub
Release. Manual dispatch repeats the same non-publishing path. The
`versioned-contract` lane in [Extended checks](../../.github/workflows/extended.yml)
runs the full application gate plus this artifact/HTTP smoke.

After the prepared source is merged, create `contract-v<info.version>` at that
merged commit. Publication requires a **protected tag** and ancestry on the default
branch. Configure an active tag ruleset for `contract-v*` that restricts creation
to release maintainers and prevents updates/deletion; keep the default branch
protected. Enable GitHub immutable releases for stronger repository-level
protection against manual asset edits. Without protected tags the workflow fails
closed. Only the publishing job receives `contents: write`; it creates the release
once with four explicit assets and no overwrite flag. Pull request code has no
publishing credentials. No deployment or tag is created by ordinary validation.

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
`getHealth` has hosted isolated-workerd release and unauthenticated HTTP conformance
evidence for `worker-preview`; this is not a managed staging deployment. It cannot
claim `staging-ready` without smoke/telemetry, or `accepted` without acceptance
evidence. Other operations remain `specified` until their documented gates have
real immutable evidence; existing implementation alone is not a promotion.

For private evidence, provide the complete authorization-header value through
`MELTIPLY_READINESS_EVIDENCE_AUTHORIZATION` and its exact HTTPS origin through
`MELTIPLY_READINESS_EVIDENCE_AUTH_ORIGIN`. Credentials are sent only to that origin.
`specified` metadata requires neither network evidence nor those credentials.
