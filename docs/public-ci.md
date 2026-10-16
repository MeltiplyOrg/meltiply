# CI checks

[The GitHub Actions workflow](../.github/workflows/ci.yml) runs on pushes, pull
requests, and manual dispatch using a standard `ubuntu-24.04` runner. Actions use
version tags, not commit-hash references.

## Quality gate

The job checks out all repository history without persisting Git credentials,
installs Node 24.18.0 and Bun 1.4.2, and runs:

- A redacted Gitleaks scan of all fetched Git refs, including removed files.
- The spelling check and generated Worker-binding drift check.
- `bun run cloudflare:check`: contracts, strict lint, dead-code and format gates,
  both frontends, shared-package/Worker types, tests and builds, PostgreSQL-backed
  integration tests, local-tooling regression suites, dependency-license/SBOM
  checks, costs, and documentation checks.
- A check that contract generation left no tracked contract changes.

The database is a disposable local Docker PostgreSQL instance with fixture-only
credentials. Cleanup runs even after a failed check. The job token has read-only
repository access; no deployment credentials are supplied. Run contribution checks
on ephemeral GitHub-hosted runners, not self-hosted runners or
`pull_request_target` jobs that execute contributor code.

## Quality tools

[The tool installer](../scripts/ci/install-quality-tool.sh) installs
Gitleaks 8.30.1 and typos 1.35.5 using versioned release archives and pinned
SHA-256 archive checksums. These verify downloads; they are not GitHub Action
commit references. Linux x64 and arm64 are supported.

The scanner retains its live synthetic detection canary. Its configuration
excludes three proven false-positive values only when their exact source path
and detection rule also match: the Argo guide's `YOUR_API_TOKEN`, the SQL DDL
column `r2_thumbnail`, and one exact example JWT whose signature is plain example
text, not a valid EdDSA signature. These are not whole-file or commit exemptions;
different credentials in those same files must still fail.

## Runner costs and branch protection

GitHub's standard hosted-runner execution is
[free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Larger runners are not free; artifact/cache storage has separate limits. This
workflow uses neither larger runners nor artifact/cache upload actions.

Configure branch protection to require `quality` after its first successful run.
Local configuration validation does not prove that a hosted job passed.
