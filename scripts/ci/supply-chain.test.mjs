import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  assertAllowedLicenses,
  cycloneDxBom,
  javascriptComponents,
  javascriptCatalog,
} from "./supply-chain.mjs";

/** Writes installed package metadata; fixtures exercise real Node resolution, not mocked graphs. */
function manifest(root, directory, metadata) {
  const path = join(root, directory, "package.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(metadata));
}

/** Creates an isolated workspace fixture and removes all files after its test. */
function fixture(context, metadata) {
  const root = mkdtempSync(join(tmpdir(), "supply-chain-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  manifest(root, ".", { name: "fixture", private: true, ...metadata });
  return root;
}

// An unknown SPDX expression must never silently pass the production license gate.
test("license policy fails closed on an unreviewed expression", () => {
  assert.throws(
    () => assertAllowedLicenses({ "GPL-3.0-only": [] }, ["MIT"], "fixture"),
    /unapproved licenses: GPL-3.0-only/,
  );
});

// SPDX alternatives need one approved option; conjunctions need every obligation.
test("license policy evaluates SPDX alternatives, precedence, and exceptions", () => {
  const allowed = ["MIT", "Apache-2.0"];
  for (const expression of [
    "(MPL-2.0 OR Apache-2.0)",
    "MIT AND (Apache-2.0 OR GPL-3.0-only)",
    "GPL-3.0-only AND MIT OR Apache-2.0",
  ]) {
    assertAllowedLicenses({ [expression]: [] }, allowed, "fixture");
  }
  for (const expression of [
    "MIT AND GPL-3.0-only",
    "MIT OR",
    "MIT WITH Classpath-exception-2.0",
    "LicenseRef-Unreviewed",
  ]) {
    assert.throws(
      () => assertAllowedLicenses({ [expression]: [] }, allowed, "fixture"),
      /unapproved licenses/,
    );
  }
});

// A reviewed development tool must not approve another version, package, or production use.
test("development license exceptions cannot broaden into general approvals", () => {
  const license = "LicenseRef-Reviewed-Tool";
  const entry = { name: "tool", versions: ["1.0.0"] };
  const exceptions = [{ name: "tool", version: "1.0.0", license }];
  assertAllowedLicenses({ [license]: [entry] }, [], "development", exceptions);
  for (const catalog of [
    { [license]: [{ name: "tool", versions: ["1.0.0", "2.0.0"] }] },
    { [license]: [entry, { name: "other", versions: ["1.0.0"] }] },
    { "LicenseRef-Other-Terms": [entry] },
  ]) {
    assert.throws(
      () => assertAllowedLicenses(catalog, [], "development", exceptions),
      /unapproved licenses/,
    );
  }
  assert.throws(
    () => assertAllowedLicenses({ [license]: [entry] }, [], "production"),
    /unapproved licenses/,
  );
});

// Missing manifest metadata is recoverable only for the reviewed version and unchanged license bytes.
test("license metadata corrections are pinned to the package and upstream text", (context) => {
  const root = fixture(context, { dependencies: { tool: "1.0.0" } });
  manifest(root, "node_modules/tool", { name: "tool", version: "1.0.0" });
  const text = "Reviewed upstream permission text\n";
  const path = join(root, "node_modules/tool/LICENSE");
  writeFileSync(path, text);
  const options = {
    licenseMetadata: [
      {
        name: "tool",
        version: "1.0.0",
        license: "MIT",
        file: "LICENSE",
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    ],
  };
  assertAllowedLicenses(javascriptCatalog(root, options), ["MIT"], "fixture");
  writeFileSync(path, "Changed terms\n");
  assert.throws(() => javascriptCatalog(root, options), /Reviewed license text changed/);
  writeFileSync(path, text);
  manifest(root, "node_modules/tool", { name: "tool", version: "2.0.0" });
  assert.throws(() => javascriptCatalog(root, options), /missing license metadata/);
});

// Exercise isolated symlinks, workspace-only roots, peers, cycles, multiple versions,
// export-hidden manifests, and dev-only exclusion in one consumer-visible inventory.
test("inventory follows installed production edges across isolated workspaces", (context) => {
  const root = fixture(context, {
    workspaces: ["packages/*"],
    dependencies: { runtime: "1.0.0" },
    devDependencies: { forbidden: "1.0.0" },
  });
  manifest(root, "node_modules/.bun/runtime/node_modules/runtime", {
    name: "runtime",
    version: "1.0.0",
    license: "MIT",
    exports: "./index.js",
    dependencies: { peer: "1.0.0" },
    devDependencies: { "uninstalled-upstream-development-tool": "1.0.0" },
    optionalDependencies: { "absent-platform": "1.0.0" },
    peerDependencies: { "optional-peer": "1.0.0" },
    peerDependenciesMeta: { "optional-peer": { optional: true } },
  });
  symlinkSync(".bun/runtime/node_modules/runtime", join(root, "node_modules/runtime"));
  manifest(root, "node_modules/peer", {
    name: "peer",
    version: "1.0.0",
    license: "MIT",
    peerDependencies: { runtime: "1.0.0" },
  });
  manifest(root, "node_modules/forbidden", {
    name: "forbidden",
    version: "1.0.0",
    license: "GPL-3.0-only",
  });
  manifest(root, "packages/app", {
    name: "app",
    private: true,
    dependencies: { runtime: "2.0.0" },
    devDependencies: { forbidden: "1.0.0" },
  });
  manifest(root, "packages/app/node_modules/runtime", {
    name: "runtime",
    version: "2.0.0",
    license: { type: "MIT" },
  });
  const catalog = javascriptCatalog(root);
  assertAllowedLicenses(catalog, ["MIT"], "fixture");
  assert.deepEqual(
    cycloneDxBom(javascriptComponents(catalog), "1.0.0").components.map(
      ({ name, version }) => `${name}@${version}`,
    ),
    ["peer@1.0.0", "runtime@1.0.0", "runtime@2.0.0"],
  );
  assert.throws(
    () =>
      assertAllowedLicenses(
        javascriptCatalog(root, { includeDevelopment: true }),
        ["MIT"],
        "development",
      ),
    /unapproved licenses: GPL-3.0-only/,
  );
});

// An optional declaration wins over a required declaration for the same package.
test("absent optional binaries are excluded but installed unlicensed binaries fail", (context) => {
  const root = fixture(context, {
    dependencies: { native: "1.0.0" },
    optionalDependencies: { native: "1.0.0" },
  });
  assert.deepEqual(javascriptCatalog(root), {});
  manifest(root, "node_modules/native", { name: "native", version: "1.0.0" });
  assert.throws(() => javascriptCatalog(root), /missing license metadata: native@1\.0\.0/);
});

// Required runtime dependencies and peers must fail closed when installation is incomplete.
test("missing required runtime edges cannot silently shrink the SBOM", (context) => {
  const root = fixture(context, { dependencies: { runtime: "1.0.0" } });
  assert.throws(() => javascriptCatalog(root), /Missing dependency runtime/);
  manifest(root, "node_modules/runtime", {
    name: "runtime",
    version: "1.0.0",
    license: "MIT",
    peerDependencies: { peer: "1.0.0" },
  });
  assert.throws(() => javascriptCatalog(root), /Missing dependency peer/);
});

test("CycloneDX inventory is deterministic, unique, and path-free", () => {
  const components = javascriptComponents({
    MIT: [
      {
        name: "@scope/example",
        paths: ["/private/workspace/node_modules/example"],
        versions: ["2.0.0", "1.0.0"],
      },
    ],
  });
  const bom = cycloneDxBom([...components, components[0]], "1.0.0");

  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.6");
  assert.equal(bom.components.length, 2);
  assert.deepEqual(
    bom.components.map((component) => component.version),
    ["1.0.0", "2.0.0"],
  );
  assert.doesNotMatch(JSON.stringify(bom), /private\/workspace|node_modules/);
});

// Compound and custom terms must not be represented as nonexistent SPDX identifiers.
test("SBOM preserves alternative licenses and reviewed custom terms", () => {
  const terms = ["(MPL-2.0 OR Apache-2.0)", "LicenseRef-React-Doctor", "PolyForm-Shield-1.0.0"];
  const components = javascriptComponents(
    Object.fromEntries(
      terms.map((license, index) => [license, [{ name: `tool-${index}`, versions: ["1.0.0"] }]]),
    ),
  );
  assert.deepEqual(
    components.map(({ licenses }) => licenses),
    [
      [{ expression: terms[0] }],
      [{ license: { name: terms[1] } }],
      [{ license: { name: terms[2] } }],
    ],
  );
});
